//! Engine, command and module tests against in-memory fake stores.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration as StdDuration;

use async_trait::async_trait;
use chrono::{DateTime, Duration, FixedOffset, TimeZone, Utc};
use miyoria_commands::{ArgValue, CommandRegistry, Invocation, Permissions, parse_account};
use miyoria_kernel::{
    EventBus, Module, ModuleContext, ModuleManifest, ServiceRegistry, Supervisor,
};
use miyoria_llm::{ChatProvider, LlmRouter, MockProvider};
use miyoria_profile::MoodBaseline;
use miyoria_store::{
    Account, IdentityStore, PeopleStore, Person, Relationship, RelationshipDelta, RelationshipStore,
};
use miyoria_types::{
    AccountRef, Author, ContextKey, ContextKind, Event, IncomingMessage, MessageRef, ModuleId,
    MoodSignals, Participant, PersonId, PlatformId, ProfileId, PromptContributor,
    PromptContributors, PromptRequest, SocialSignals, TurnId,
};
use parking_lot::Mutex;

use super::engine::{LinkOutcome, Observed, Social, SocialStores, merge_into};
use super::rel::{DayLedger, EventKind, familiarity_change, label};
use super::{SocialConfig, SocialModule, SocialPrompt, TOPIC, register_commands};
use crate::MoodModule;

// ---------------------------------------------------------------- fakes ---

#[derive(Default)]
struct Inner {
    people: HashMap<PersonId, Person>,
    accounts: HashMap<AccountRef, PersonId>,
    rels: HashMap<(ProfileId, PersonId), Relationship>,
    deltas: Vec<(ProfileId, PersonId, RelationshipDelta)>,
    codes: HashMap<String, (AccountRef, DateTime<Utc>)>,
}

/// People, relationships and identity in one in-memory fake.
#[derive(Default)]
struct FakeStore {
    inner: Mutex<Inner>,
}

impl FakeStore {
    fn deltas(&self, person: PersonId) -> Vec<RelationshipDelta> {
        self.inner
            .lock()
            .deltas
            .iter()
            .filter(|(_, p, _)| *p == person)
            .map(|(_, _, d)| d.clone())
            .collect()
    }

    fn stored(&self, person: PersonId) -> Option<Relationship> {
        self.inner.lock().rels.get(&(profile(), person)).cloned()
    }

    fn person_of(&self, account: &AccountRef) -> Option<PersonId> {
        self.inner.lock().accounts.get(account).copied()
    }
}

#[async_trait]
impl PeopleStore for FakeStore {
    async fn upsert_account(&self, account: &AccountRef, name: &str) -> anyhow::Result<PersonId> {
        let mut inner = self.inner.lock();
        if let Some(p) = inner.accounts.get(account) {
            return Ok(*p);
        }
        let id = PersonId::new();
        let now = Utc::now();
        inner.people.insert(
            id,
            Person {
                id,
                display_name: name.to_owned(),
                created_at: now,
                accounts: vec![Account {
                    account: account.clone(),
                    display_name: name.to_owned(),
                    first_seen: now,
                    last_seen: now,
                }],
            },
        );
        inner.accounts.insert(account.clone(), id);
        Ok(id)
    }

    async fn person_by_account(&self, account: &AccountRef) -> anyhow::Result<Option<Person>> {
        let inner = self.inner.lock();
        Ok(inner
            .accounts
            .get(account)
            .and_then(|p| inner.people.get(p))
            .cloned())
    }
}

#[async_trait]
impl RelationshipStore for FakeStore {
    async fn get(
        &self,
        profile: &ProfileId,
        person: PersonId,
    ) -> anyhow::Result<Option<Relationship>> {
        Ok(self
            .inner
            .lock()
            .rels
            .get(&(profile.clone(), person))
            .cloned())
    }

    async fn upsert(&self, r: &Relationship) -> anyhow::Result<()> {
        self.inner
            .lock()
            .rels
            .insert((r.profile.clone(), r.person), r.clone());
        Ok(())
    }

    async fn list(&self, profile: &ProfileId) -> anyhow::Result<Vec<Relationship>> {
        Ok(self
            .inner
            .lock()
            .rels
            .values()
            .filter(|r| &r.profile == profile)
            .cloned()
            .collect())
    }

    async fn delete(&self, profile: &ProfileId, person: PersonId) -> anyhow::Result<bool> {
        Ok(self
            .inner
            .lock()
            .rels
            .remove(&(profile.clone(), person))
            .is_some())
    }

    async fn record_delta(
        &self,
        profile: &ProfileId,
        person: PersonId,
        delta: &RelationshipDelta,
    ) -> anyhow::Result<()> {
        self.inner
            .lock()
            .deltas
            .push((profile.clone(), person, delta.clone()));
        Ok(())
    }

    async fn deltas_since(
        &self,
        profile: &ProfileId,
        person: PersonId,
        since: DateTime<Utc>,
    ) -> anyhow::Result<Vec<RelationshipDelta>> {
        Ok(self
            .inner
            .lock()
            .deltas
            .iter()
            .filter(|(pr, p, d)| pr == profile && *p == person && d.at >= since)
            .map(|(_, _, d)| d.clone())
            .collect())
    }
}

#[async_trait]
impl IdentityStore for FakeStore {
    async fn link_account(&self, account: &AccountRef, person: PersonId) -> anyhow::Result<()> {
        let mut inner = self.inner.lock();
        let old = inner.accounts.insert(account.clone(), person);
        let mut moved = None;
        if let Some(old) = old
            && let Some(p) = inner.people.get_mut(&old)
        {
            if let Some(i) = p.accounts.iter().position(|a| &a.account == account) {
                moved = Some(p.accounts.remove(i));
            }
        }
        if let Some(a) = moved
            && let Some(p) = inner.people.get_mut(&person)
        {
            p.accounts.push(a);
        }
        Ok(())
    }

    async fn merge_people(&self, keep: PersonId, absorb: PersonId) -> anyhow::Result<()> {
        let mut inner = self.inner.lock();
        let gone = inner.people.remove(&absorb);
        for p in inner.accounts.values_mut() {
            if *p == absorb {
                *p = keep;
            }
        }
        if let Some(gone) = gone
            && let Some(p) = inner.people.get_mut(&keep)
        {
            p.accounts.extend(gone.accounts);
        }
        Ok(())
    }

    async fn accounts_of(&self, person: PersonId) -> anyhow::Result<Vec<Account>> {
        Ok(self
            .inner
            .lock()
            .people
            .get(&person)
            .map(|p| p.accounts.clone())
            .unwrap_or_default())
    }

    async fn set_person_name(&self, person: PersonId, name: &str) -> anyhow::Result<()> {
        if let Some(p) = self.inner.lock().people.get_mut(&person) {
            p.display_name = name.to_owned();
        }
        Ok(())
    }

    async fn create_link_code(
        &self,
        code: &str,
        account: &AccountRef,
        expires_at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        self.inner
            .lock()
            .codes
            .insert(code.to_owned(), (account.clone(), expires_at));
        Ok(())
    }

    async fn consume_link_code(
        &self,
        code: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Option<AccountRef>> {
        Ok(self
            .inner
            .lock()
            .codes
            .remove(code)
            .filter(|(_, exp)| *exp > now)
            .map(|(a, _)| a))
    }
}

// -------------------------------------------------------------- helpers ---

fn profile() -> ProfileId {
    ProfileId::from("deepseek-chan")
}

fn acc(s: &str) -> AccountRef {
    parse_account(s).unwrap()
}

fn dm() -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: None,
        channel: "dm1".into(),
        kind: ContextKind::Dm,
    }
}

fn channel() -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some("g".into()),
        channel: "c".into(),
        kind: ContextKind::Channel,
    }
}

/// Local (UTC+8) time on day `d` of November 2026.
fn t(d: u32, h: u32) -> DateTime<Utc> {
    FixedOffset::east_opt(8 * 3600)
        .unwrap()
        .with_ymd_and_hms(2026, 11, d, h, 0, 0)
        .unwrap()
        .with_timezone(&Utc)
}

struct Harness {
    social: Arc<Social>,
    store: Arc<FakeStore>,
    events: Arc<Mutex<Vec<Event>>>,
}

fn harness_with(config: SocialConfig, store: Arc<FakeStore>) -> Harness {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let social = Arc::new(Social::new(
        profile(),
        "DeepSeek-chan",
        vec!["DS醬".into(), "小鯨魚".into()],
        config,
        SocialStores {
            people: store.clone(),
            relationships: store.clone(),
            identity: Some(store.clone()),
        },
        Arc::new(move |e| sink.lock().push(e)),
    ));
    Harness {
        social,
        store,
        events,
    }
}

fn harness() -> Harness {
    harness_with(SocialConfig::default(), Arc::new(FakeStore::default()))
}

impl Harness {
    async fn say(
        &self,
        who: &str,
        name: &str,
        text: &str,
        ctx: ContextKey,
        at: DateTime<Utc>,
    ) -> bool {
        self.social
            .observe(Observed {
                directed: ctx.kind == ContextKind::Dm,
                context: ctx,
                account: acc(who),
                display_name: name.into(),
                text: text.into(),
                ts: at,
            })
            .await
            .unwrap()
    }

    fn rel(&self, who: &str) -> Relationship {
        let p = self.social.person_of(&acc(who)).expect("known account");
        self.social.relationship(p).expect("relationship")
    }

    fn topics(&self) -> Vec<serde_json::Value> {
        self.events
            .lock()
            .iter()
            .filter_map(|e| match e {
                Event::Custom { topic, payload } if topic == TOPIC => Some(payload.clone()),
                _ => None,
            })
            .collect()
    }
}

fn router(mock: Arc<MockProvider>) -> LlmRouter {
    let mut providers: HashMap<String, Arc<dyn ChatProvider>> = HashMap::new();
    providers.insert("mock".into(), mock);
    let mut purposes = HashMap::new();
    purposes.insert("fast".into(), vec!["mock:fast-model".parse().unwrap()]);
    LlmRouter::new(providers, purposes)
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 1e-3
}

// ---------------------------------------------------------------- tests ---

#[test]
fn ledger_caps_and_diminishing_returns() {
    let config = SocialConfig::default();
    let mut l = DayLedger::new(t(1, 12).date_naive());
    assert_eq!(
        l.take(EventKind::Gift, EventKind::Gift.base(1.0), &config),
        (3.0, 1.0)
    );
    assert_eq!(
        l.take(EventKind::Gift, EventKind::Gift.base(1.0), &config),
        (1.5, 0.5)
    );
    let (a, _) = l.take(EventKind::Praise, EventKind::Praise.base(1.0), &config);
    assert!(close(a, 1.5));
    l.take(EventKind::Thanks, EventKind::Thanks.base(1.0), &config);
    l.take(EventKind::Apology, EventKind::Apology.base(1.0), &config);
    assert!(close(l.affinity_gained, 8.0));
    let (a, tr) = l.take(EventKind::Friendly, EventKind::Friendly.base(1.0), &config);
    assert!(close(a, 0.0), "affinity cap reached");
    assert!(tr > 0.0, "trust cap not reached yet");

    // Losses have their own budget.
    let mut l = DayLedger::new(t(1, 12).date_naive());
    let h = EventKind::Harassment.base(1.0);
    assert_eq!(l.take(EventKind::Harassment, h, &config), (-5.0, -3.0));
    assert_eq!(l.take(EventKind::Harassment, h, &config), (-2.5, -1.5));
    let (a, tr) = l.take(EventKind::Insult, EventKind::Insult.base(1.0), &config);
    assert!(close(a, -0.5) && close(tr, -0.5), "{a} {tr}");
}

#[test]
fn labels() {
    let mut r = Relationship {
        profile: profile(),
        person: PersonId::new(),
        affinity: 0.0,
        trust: 10.0,
        familiarity: 0.0,
        tags: vec![],
        notes: String::new(),
        call_name: None,
        interactions: 0,
        last_interaction: None,
        updated_at: Utc::now(),
    };
    let mut check = |a: f32, f: f32, want: &str| {
        r.affinity = a;
        r.familiarity = f;
        assert_eq!(label(&r), want, "affinity {a} familiarity {f}");
    };
    check(0.0, 0.0, "陌生人");
    check(5.0, 5.0, "認識");
    check(20.0, 1.0, "朋友");
    check(50.0, 20.0, "好朋友");
    check(50.0, 5.0, "朋友");
    check(80.0, 40.0, "摯友");
    check(80.0, 20.0, "好朋友");
    check(-20.0, 50.0, "討厭");
    check(-60.0, 50.0, "很討厭");
}

#[test]
fn familiarity_grows_per_day_and_decays_without_contact() {
    let c = SocialConfig::default();
    assert!(close(familiarity_change(None, t(1, 12), &c), 1.0));
    assert!(close(familiarity_change(Some(t(1, 9)), t(1, 23), &c), 0.0));
    assert!(close(familiarity_change(Some(t(1, 23)), t(2, 1), &c), 1.0));
    // 19 days without contact, 7 of grace: 12 days of decay.
    assert!(close(
        familiarity_change(Some(t(1, 12)), t(21, 12), &c),
        1.0 - 12.0 * 0.5
    ));
}

#[tokio::test]
async fn rules_are_capped_per_day_and_survive_restart() {
    let h = harness();
    for i in 0..20 {
        h.say(
            "discord:2",
            "Amy",
            "謝謝你,你好可愛",
            dm(),
            t(1, 10) + Duration::minutes(i),
        )
        .await;
    }
    let r = h.rel("discord:2");
    // thanks: 1 + .5 + .25 ... < 2, praise: 1.5 + .75 ... < 3.
    assert!(r.affinity > 4.5 && r.affinity < 5.001, "{}", r.affinity);
    assert!(close(r.familiarity, 1.0), "one interaction day");
    assert_eq!(r.interactions, 20);
    let p = h.social.person_of(&acc("discord:2")).unwrap();
    let reasons: Vec<String> = h.store.deltas(p).into_iter().map(|d| d.reason).collect();
    assert!(reasons.contains(&"rule: thanks".to_owned()));
    assert!(reasons.contains(&"familiarity: day".to_owned()));
    assert!(!h.topics().is_empty());

    // A restart rebuilds today's ledger from the recorded deltas.
    let before = h.store.stored(p).unwrap().affinity;
    let again = harness_with(SocialConfig::default(), h.store.clone());
    again.social.load().await.unwrap();
    again.say("discord:2", "Amy", "謝謝", dm(), t(1, 11)).await;
    let gain = again.rel("discord:2").affinity - before;
    assert!(gain < 0.001, "21st thanks of the day is worth ~0: {gain}");

    // A new day has a new budget.
    again.say("discord:2", "Amy", "謝謝", dm(), t(2, 11)).await;
    let r = again.rel("discord:2");
    assert!(close(r.affinity - before, 1.0), "{}", r.affinity - before);
    assert!(close(r.familiarity, 2.0));
}

#[tokio::test]
async fn rules_only_count_lines_said_to_her() {
    let h = harness();
    h.say("discord:2", "Amy", "謝謝你喔 Bob", channel(), t(1, 10))
        .await;
    assert!(close(h.rel("discord:2").affinity, 0.0));
    h.say("discord:2", "Amy", "DS醬謝謝你", channel(), t(1, 10))
        .await;
    assert!(close(h.rel("discord:2").affinity, 1.0));
    // Right after she spoke, lines count as answers to her.
    h.social
        .observe_self(&channel(), "<emo:happy>哼,不客氣。", t(1, 11));
    h.say(
        "discord:3",
        "Bob",
        "你好棒",
        channel(),
        t(1, 11) + Duration::seconds(10),
    )
    .await;
    assert!(h.rel("discord:3").affinity > 0.0);
}

#[tokio::test]
async fn owner_floor_and_auto_tag() {
    let h = harness();
    h.social.set_authorizer(Some(Arc::new(
        Permissions::from_strings(&["discord:1"]).unwrap(),
    )));
    h.say("discord:1", "Owen", "嗨", dm(), t(1, 10)).await;
    let r = h.rel("discord:1");
    assert!(r.tags.contains(&"owner".to_owned()));
    assert!(close(r.trust, 100.0) && close(r.affinity, 30.5), "{r:?}");
    assert_eq!(label(&r), "朋友");
    for _ in 0..5 {
        h.say("discord:1", "Owen", "你這個智障", dm(), t(1, 11))
            .await;
    }
    let r = h.rel("discord:1");
    assert!(close(r.affinity, 30.0) && close(r.trust, 100.0), "{r:?}");

    // A normal person is not tagged.
    h.say("discord:2", "Amy", "嗨", dm(), t(1, 10)).await;
    assert!(h.rel("discord:2").tags.is_empty());
}

#[tokio::test]
async fn blocked_people_are_ignored() {
    let h = harness();
    h.say("discord:5", "Troll", "嗨", dm(), t(1, 10)).await;
    let p = h.social.person_of(&acc("discord:5")).unwrap();
    assert!(
        h.social
            .set_tag(p, "blocked", true, "test", t(1, 10))
            .await
            .unwrap()
    );
    let n = h.store.deltas(p).len();
    h.say("discord:5", "Troll", "去死啦白痴", dm(), t(1, 11))
        .await;
    assert_eq!(h.store.deltas(p).len(), n, "no changes while blocked");
    let a = h.social.attitude(&acc("discord:5")).unwrap();
    assert!(a.blocked);
    let lines = h.social.describe_people(
        &[Participant {
            account: acc("discord:5"),
            display_name: "Troll".into(),
            person: None,
        }],
        &[],
    );
    assert!(lines[0].contains("不理"), "{lines:?}");
}

#[tokio::test]
async fn llm_appraisal_is_parsed_and_applied() {
    let config = SocialConfig {
        appraisal_every_lines: 3,
        ..SocialConfig::default()
    };
    let h = harness_with(config, Arc::new(FakeStore::default()));
    let mock = Arc::new(MockProvider::new("mock").reply(
        r#"```json
{"people":[
 {"person_name":"Alice","toward_her":0.8,"events":["praise","thanks"]},
 {"person_name":"Bob","toward_her":-0.6,"events":["insult"]},
 {"person_name":"DeepSeek-chan","toward_her":1,"events":["gift"]}
]}
```"#,
    ));
    let r = router(mock.clone());
    assert!(
        !h.say("discord:2", "Alice", "DS醬謝謝", channel(), t(1, 10))
            .await
    );
    assert!(
        !h.say("discord:3", "Bob", "她很爛", channel(), t(1, 10))
            .await
    );
    assert!(
        h.say("discord:2", "Alice", "她真的超可愛", channel(), t(1, 10))
            .await
    );
    let applied = h.social.appraise(&r, &channel(), t(1, 10)).await.unwrap();
    assert_eq!(applied, 2);

    let request = &mock.requests()[0];
    assert!(request.json_mode);
    assert_eq!(request.model, "fast-model");
    assert!(request.messages[0].content.contains("Alice、Bob"));
    assert!(request.messages[1].content.contains("Bob: 她很爛"));

    let alice = h.social.person_of(&acc("discord:2")).unwrap();
    let reasons: Vec<String> = h
        .store
        .deltas(alice)
        .into_iter()
        .map(|d| d.reason)
        .collect();
    assert!(reasons.contains(&"appraisal: praise".to_owned()));
    assert!(reasons.contains(&"appraisal: warm".to_owned()));
    assert!(reasons.contains(&"rule: thanks".to_owned()));
    assert!(
        !reasons.contains(&"appraisal: thanks".to_owned()),
        "thanks already counted by the rules"
    );
    let bob = h.rel("discord:3");
    assert!(bob.affinity < -3.0, "{}", bob.affinity);

    // Nothing new: no second call.
    assert_eq!(
        h.social.appraise(&r, &channel(), t(1, 10)).await.unwrap(),
        0
    );
    assert_eq!(mock.requests().len(), 1);

    // Idle contexts become due.
    h.say("discord:3", "Bob", "嗯", channel(), t(1, 11)).await;
    assert!(h.social.due_appraisals(t(1, 11)).is_empty());
    assert_eq!(h.social.due_appraisals(t(1, 12)), vec![channel()]);
}

#[tokio::test]
async fn bad_llm_answers_change_nothing() {
    let h = harness();
    let r = router(Arc::new(MockProvider::new("mock").reply("我拒絕回答")));
    h.say("discord:3", "Bob", "hello", channel(), t(1, 10))
        .await;
    let before = h.rel("discord:3");
    assert!(h.social.appraise(&r, &channel(), t(1, 10)).await.is_err());
    assert!(close(h.rel("discord:3").affinity, before.affinity));
}

#[tokio::test]
async fn notes_refresh_and_prompt() {
    let config = SocialConfig {
        notes_every_lines: 2,
        ..SocialConfig::default()
    };
    let h = harness_with(config, Arc::new(FakeStore::default()));
    h.say("discord:2", "Amy", "我今天去水族館看鯨魚", dm(), t(1, 10))
        .await;
    assert!(h.social.due_notes(t(1, 10)).is_empty());
    h.social.observe_self(&dm(), "鯨魚很可愛吧!", t(1, 10));
    h.say("discord:2", "Amy", "對啊超大", dm(), t(1, 10)).await;
    let p = h.social.person_of(&acc("discord:2")).unwrap();
    assert_eq!(h.social.due_notes(t(1, 10)), vec![p]);

    let mock =
        Arc::new(MockProvider::new("mock").reply(r#"{"notes":"喜歡鯨魚的人,品味還不錯。"}"#));
    assert!(
        h.social
            .refresh_notes(&router(mock.clone()), p, t(1, 10))
            .await
            .unwrap()
    );
    assert_eq!(h.rel("discord:2").notes, "喜歡鯨魚的人,品味還不錯。");
    assert!(
        mock.requests()[0].messages[1]
            .content
            .contains("DeepSeek-chan: 鯨魚很可愛吧!")
    );
    assert!(h.social.due_notes(t(1, 10)).is_empty());
    h.social
        .set_call_name(p, Some("阿美".into()), t(1, 10))
        .await
        .unwrap();

    let prompt = SocialPrompt::new(h.social.clone());
    let request = PromptRequest {
        profile: profile(),
        turn: TurnId::new(),
        context: dm(),
        participants: vec![
            Participant {
                account: acc("discord:9"),
                display_name: "Newbie".into(),
                person: None,
            },
            Participant {
                account: acc("discord:2"),
                display_name: "Amy".into(),
                person: None,
            },
        ],
        speakers: vec![acc("discord:2")],
        query: String::new(),
        recent: vec![],
        voice: false,
        now: t(1, 10),
    };
    let sections = prompt.contribute(&request).await.unwrap();
    assert_eq!(sections[0].title, "在場的人");
    let body = &sections[0].body;
    assert!(
        body.starts_with("- Amy:陌生人;稱呼「阿美」;印象:喜歡鯨魚的人"),
        "{body}"
    );
    assert!(body.contains("- Newbie:陌生人"));
}

#[tokio::test]
async fn link_code_flow() {
    let h = harness();
    let a = acc("discord:1");
    let b = acc("twitch:9");
    h.say("discord:1", "Owen", "嗨", dm(), t(1, 10)).await;
    let keep = h.social.person_of(&a).unwrap();
    h.social.adjust(keep, 5.0, "test", t(1, 10)).await.unwrap();

    let code = h
        .social
        .issue_link_code(&a, "Owen", t(1, 10))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(code.len(), 8);
    assert_eq!(
        h.social
            .redeem_link_code(&a, "Owen", &code, t(1, 10))
            .await
            .unwrap(),
        LinkOutcome::SameAccount
    );
    let code = h
        .social
        .issue_link_code(&a, "Owen", t(1, 10))
        .await
        .unwrap()
        .unwrap();
    // Twitch account already has a better relationship.
    let absorb = h
        .social
        .resolve(&b, Some("owen_tw"), t(1, 10))
        .await
        .unwrap()
        .unwrap();
    h.social
        .adjust(absorb, 20.0, "test", t(1, 10))
        .await
        .unwrap();
    h.social
        .set_call_name(absorb, Some("歐文".into()), t(1, 10))
        .await
        .unwrap();

    assert_eq!(
        h.social
            .redeem_link_code(&b, "owen_tw", "WRONG123", t(1, 10))
            .await
            .unwrap(),
        LinkOutcome::InvalidCode
    );
    let expired = t(1, 10) + Duration::minutes(11);
    assert_eq!(
        h.social
            .redeem_link_code(&b, "owen_tw", &code.to_lowercase(), expired)
            .await
            .unwrap(),
        LinkOutcome::InvalidCode
    );
    let code = h
        .social
        .issue_link_code(&a, "Owen", t(1, 10))
        .await
        .unwrap()
        .unwrap();
    let outcome = h
        .social
        .redeem_link_code(&b, "owen_tw", &code.to_lowercase(), t(1, 10))
        .await
        .unwrap();
    assert_eq!(
        outcome,
        LinkOutcome::Linked {
            keep,
            absorbed: absorb
        }
    );

    assert_eq!(h.social.person_of(&b), Some(keep));
    assert_eq!(h.store.person_of(&b), Some(keep));
    let merged = h.store.stored(keep).unwrap();
    assert!(
        close(merged.affinity, 20.0),
        "higher affinity kept: {merged:?}"
    );
    assert_eq!(merged.call_name.as_deref(), Some("歐文"));
    assert!(h.store.stored(absorb).is_none());
    assert_eq!(
        h.social.attitude(&a).unwrap().person,
        h.social.attitude(&b).unwrap().person
    );
    assert_eq!(
        h.social
            .redeem_link_code(&b, "owen_tw", &code, t(1, 10))
            .await
            .unwrap(),
        LinkOutcome::InvalidCode,
        "codes are one-time"
    );
    for _ in 0..5 {
        h.social
            .redeem_link_code(&b, "x", "NOPE", t(1, 10))
            .await
            .unwrap();
    }
    assert_eq!(
        h.social
            .redeem_link_code(&b, "x", "NOPE", t(1, 10))
            .await
            .unwrap(),
        LinkOutcome::TooManyAttempts
    );
}

#[test]
fn merge_keeps_higher_affinity_and_combines_the_rest() {
    let base = |a: f32, f: f32, tags: &[&str], notes: &str| Relationship {
        profile: profile(),
        person: PersonId::new(),
        affinity: a,
        trust: a,
        familiarity: f,
        tags: tags.iter().map(|s| (*s).to_owned()).collect(),
        notes: notes.into(),
        call_name: None,
        interactions: 3,
        last_interaction: Some(t(1, 10)),
        updated_at: t(1, 10),
    };
    let mut keep = base(5.0, 30.0, &["regular"], "");
    let person = keep.person;
    merge_into(&mut keep, base(40.0, 10.0, &["friend"], "很好的人"));
    assert_eq!(keep.person, person);
    assert!(close(keep.affinity, 40.0) && close(keep.trust, 40.0));
    assert!(close(keep.familiarity, 30.0));
    assert_eq!(keep.interactions, 6);
    assert_eq!(keep.notes, "很好的人");
    assert_eq!(keep.tags, vec!["regular", "friend"]);
}

fn inv(who: &str, path: &str, args: &[(&str, ArgValue)], guild_admin: bool) -> Invocation {
    let mut i = Invocation::new(path, acc(who), channel());
    i.args = args
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect::<BTreeMap<_, _>>();
    i.invoker_display_name = format!("user{}", who.rsplit(':').next().unwrap());
    i.invoker_is_guild_admin = guild_admin;
    i
}

fn s(v: &str) -> ArgValue {
    ArgValue::String(v.into())
}

#[tokio::test]
async fn commands() {
    let h = harness();
    let registry = CommandRegistry::new(Permissions::from_strings(&["discord:1"]).unwrap());
    register_commands(&registry, h.social.clone()).unwrap();
    let run = |i: Invocation| {
        let registry = &registry;
        async move { registry.dispatch(i).await.unwrap().text }
    };

    let me = run(inv("discord:2", "me", &[], false)).await;
    assert!(me.contains("陌生人") && me.contains("/me call"), "{me}");
    assert!(!me.contains('.'), "no exact numbers: {me}");
    let refused = run(inv("discord:2", "me", &[("call", s("笨蛋"))], false)).await;
    assert!(refused.contains("才不要"), "{refused}");
    let set = run(inv("discord:2", "me", &[("call", s("小明"))], false)).await;
    assert!(set.contains("小明"), "{set}");
    let me = run(inv("discord:2", "me", &[], false)).await;
    assert!(me.contains("我都叫你「小明」"), "{me}");

    let denied = run(inv(
        "discord:2",
        "admin person show",
        &[("user", s("<@2>"))],
        false,
    ))
    .await;
    assert!(denied.contains("權限"), "{denied}");
    let shown = run(inv(
        "discord:3",
        "admin person show",
        &[("user", s("<@!2>"))],
        true,
    ))
    .await;
    assert!(
        shown.contains("好感 0.0") && shown.contains("小明"),
        "{shown}"
    );
    let by_name = run(inv(
        "discord:3",
        "admin person show",
        &[("user", s("user2"))],
        true,
    ))
    .await;
    assert!(by_name.contains("**user2**"), "{by_name}");
    let unknown = run(inv(
        "discord:3",
        "admin person show",
        &[("user", s("discord:404"))],
        true,
    ))
    .await;
    assert!(unknown.contains("不認識"), "{unknown}");

    let tag = run(inv(
        "discord:3",
        "admin person tag",
        &[("user", s("2")), ("tag", s("Regular"))],
        true,
    ))
    .await;
    assert!(tag.contains("`regular`"), "{tag}");
    let owner_tag = run(inv(
        "discord:3",
        "admin person tag",
        &[("user", s("2")), ("tag", s("owner"))],
        true,
    ))
    .await;
    assert!(owner_tag.contains("只有我的主人"), "{owner_tag}");
    let bad_tag = run(inv(
        "discord:3",
        "admin person tag",
        &[("user", s("2")), ("tag", s("壞 人"))],
        true,
    ))
    .await;
    assert!(bad_tag.contains("標籤只能"), "{bad_tag}");

    let adjust_args = [("user", s("2")), ("affinity", ArgValue::Integer(25))];
    let not_owner = run(inv("discord:3", "admin person adjust", &adjust_args, true)).await;
    assert!(not_owner.contains("只有我的主人"), "{not_owner}");
    let adjusted = run(inv("discord:1", "admin person adjust", &adjust_args, false)).await;
    assert!(
        adjusted.contains("+25") && adjusted.contains("朋友"),
        "{adjusted}"
    );
    let me = run(inv("discord:2", "me", &[], false)).await;
    assert!(me.contains("朋友"), "{me}");

    let blocked = run(inv(
        "discord:3",
        "admin person block",
        &[("user", s("2"))],
        true,
    ))
    .await;
    assert!(blocked.contains("不會再理"), "{blocked}");
    let me = run(inv("discord:2", "me", &[], false)).await;
    assert!(me.contains("不想跟你說話"), "{me}");
    run(inv(
        "discord:3",
        "admin person unblock",
        &[("user", s("2"))],
        true,
    ))
    .await;

    let reset = run(inv(
        "discord:3",
        "admin person reset",
        &[("user", s("2"))],
        true,
    ))
    .await;
    assert!(reset.contains("歸零"), "{reset}");
    let r = h.rel("discord:2");
    assert!(close(r.affinity, 0.0) && r.call_name.is_none());
    assert_eq!(r.tags, vec!["regular"], "tags survive a reset");

    let issued = run(inv("discord:2", "link", &[], false)).await;
    let code = issued.split('`').nth(1).unwrap().to_owned();
    let linked = run(inv("discord:7", "link", &[("code", s(&code))], false)).await;
    assert!(linked.contains("都是你"), "{linked}");
    assert_eq!(
        h.social.person_of(&acc("discord:7")),
        h.social.person_of(&acc("discord:2"))
    );
}

// ---------------------------------------------------------- module test ---

struct LlmStub {
    manifest: ModuleManifest,
    router: Arc<LlmRouter>,
}

#[async_trait]
impl Module for LlmStub {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        ctx.provide(self.router.clone());
        Ok(())
    }
}

async fn eventually<F: Fn() -> bool>(what: &str, f: F) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(StdDuration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn modules_wire_services_and_events() {
    let bus = EventBus::default();
    let services = Arc::new(ServiceRegistry::new());
    let kernel = ModuleId::from("kernel");
    let store = Arc::new(FakeStore::default());
    services.provide::<dyn PeopleStore>(&kernel, store.clone());
    services.provide::<dyn RelationshipStore>(&kernel, store.clone());
    services.provide::<dyn IdentityStore>(&kernel, store.clone());
    let contributors = Arc::new(PromptContributors::new());
    services.provide(&kernel, contributors.clone());
    let sup = Supervisor::new(bus.clone(), services.clone());
    let mock = Arc::new(MockProvider::new("mock").reply(r#"{"people":[]}"#));
    sup.register(
        Arc::new(LlmStub {
            manifest: ModuleManifest::new("llm", "LLM stub"),
            router: Arc::new(router(mock)),
        }),
        serde_json::Value::Null,
        true,
    )
    .await;
    sup.register(
        Arc::new(SocialModule::with_names(
            profile(),
            "DeepSeek-chan",
            vec!["DS醬".into()],
        )),
        serde_json::Value::Null,
        true,
    )
    .await;
    sup.register(
        Arc::new(MoodModule::new(
            profile(),
            MoodBaseline {
                valence: 0.1,
                arousal: 0.5,
                energy: 0.7,
            },
        )),
        serde_json::Value::Null,
        true,
    )
    .await;
    sup.start_all().await.unwrap();

    let signals = services.require::<dyn SocialSignals>().unwrap();
    let mood = services.require::<dyn MoodSignals>().unwrap();
    let keys: Vec<String> = contributors
        .all()
        .iter()
        .map(|c| c.key().to_owned())
        .collect();
    assert_eq!(keys, vec!["mood", "social"]);
    let valence_before = mood.mood().valence;

    let mut changed = bus.subscribe(miyoria_kernel::TopicFilter::new(["mood.changed"]));
    let src = ModuleId::from("platform.test");
    bus.publish(
        &src,
        Event::PlatformReady {
            platform: PlatformId::new("discord"),
            self_account: acc("discord:999"),
        },
        None,
    );
    for (who, text) in [
        ("discord:999", "我是她自己"),
        ("discord:2", "DS醬你送我的禮物好棒,謝謝"),
    ] {
        bus.publish(
            &src,
            Event::PlatformMessageCreated(IncomingMessage {
                id: MessageRef {
                    context: channel(),
                    id: "m1".into(),
                },
                author: Author {
                    account: acc(who),
                    display_name: "Amy".into(),
                    is_bot: false,
                },
                text: text.into(),
                mentions_self: false,
                reply_to_self: false,
                attachments: vec![],
                ts: Utc::now(),
            }),
            None,
        );
    }
    eventually("attitude", || {
        signals
            .attitude(&acc("discord:2"))
            .is_some_and(|a| a.affinity > 2.0)
    })
    .await;
    assert!(
        signals.attitude(&acc("discord:999")).is_none(),
        "her own account is skipped"
    );
    let env = tokio::time::timeout(StdDuration::from_secs(2), changed.recv())
        .await
        .expect("mood.changed published")
        .unwrap();
    assert_eq!(env.topic(), "mood.changed");
    assert!(mood.mood().valence > valence_before);

    sup.stop_all().await;
    assert!(contributors.all().is_empty());
}
