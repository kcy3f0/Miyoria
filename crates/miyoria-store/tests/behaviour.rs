//! One behaviour suite, run against every backend.
//!
//! The memory backend always runs. The PostgreSQL backend runs only when
//! `MIYORIA_TEST_DATABASE_URL` is set; otherwise its tests pass with a skip
//! message. Every case uses fresh ids, so it can share a database with other
//! runs.

use chrono::{DateTime, Duration, SubsecRound, Utc};
use miyoria_store::{DecisionRecord, LogEntry, Store};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, DecisionTrace, ModuleId, PlatformId, ProfileId, TurnId,
};
use serde_json::json;
use ulid::Ulid;

const DB_ENV: &str = "MIYORIA_TEST_DATABASE_URL";

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", Ulid::new())
}

fn account(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: id.to_owned(),
    }
}

fn channel(scope: Option<&str>, channel: &str, kind: ContextKind) -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: scope.map(str::to_owned),
        channel: channel.to_owned(),
        kind,
    }
}

fn entry(profile: &ProfileId, context: &ContextKey, text: &str, ts: DateTime<Utc>) -> LogEntry {
    LogEntry {
        id: Ulid::new(),
        profile: profile.clone(),
        context: context.clone(),
        author: account("100"),
        author_name: "Owen".to_owned(),
        text: text.to_owned(),
        is_self: false,
        ts,
        turn: None,
    }
}

fn texts(entries: &[LogEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.text.as_str()).collect()
}

fn decision(
    profile: &ProfileId,
    context: &ContextKey,
    reason: &str,
    ts: DateTime<Utc>,
) -> DecisionRecord {
    DecisionRecord {
        id: Ulid::new(),
        profile: profile.clone(),
        ts,
        trace: DecisionTrace {
            turn: TurnId::new(),
            context: context.clone(),
            respond: false,
            score: 0.25,
            reasons: vec![reason.to_owned()],
        },
    }
}

fn reasons(records: &[DecisionRecord]) -> Vec<&str> {
    records
        .iter()
        .map(|r| r.trace.reasons[0].as_str())
        .collect()
}

mod cases {
    use super::*;

    pub async fn message_log_recent(store: &Store) {
        let log = &store.messages;
        let profile = ProfileId(unique("profile"));
        let ctx = channel(Some("guild"), &unique("chan"), ContextKind::Channel);
        let t0 = Utc::now().trunc_subsecs(6);

        // Appended out of order; equal timestamps keep append order.
        for (text, secs) in [("b", 2), ("a", 1), ("c", 3), ("d1", 4), ("d2", 4), ("e", 5)] {
            log.append(&entry(&profile, &ctx, text, t0 + Duration::seconds(secs)))
                .await
                .unwrap();
        }

        let all = log.recent(&profile, &ctx, 100).await.unwrap();
        assert_eq!(texts(&all), ["a", "b", "c", "d1", "d2", "e"]);
        let last = log.recent(&profile, &ctx, 3).await.unwrap();
        assert_eq!(texts(&last), ["d1", "d2", "e"]);
        assert!(log.recent(&profile, &ctx, 0).await.unwrap().is_empty());
    }

    pub async fn message_log_round_trip(store: &Store) {
        let log = &store.messages;
        let profile = ProfileId(unique("profile"));
        let ctx = channel(None, &unique("dm"), ContextKind::Dm);
        let mut e = entry(&profile, &ctx, "她說的話", Utc::now());
        e.author = account("999");
        e.author_name = "Miyori".to_owned();
        e.is_self = true;
        e.turn = Some(TurnId::new());
        log.append(&e).await.unwrap();

        let got = log.recent(&profile, &ctx, 10).await.unwrap();
        e.ts = e.ts.trunc_subsecs(6);
        assert_eq!(got, vec![e.clone()]);

        assert!(log.append(&e).await.is_err(), "duplicate id must fail");
    }

    pub async fn message_log_isolation(store: &Store) {
        let log = &store.messages;
        let profile = ProfileId(unique("profile"));
        let other_profile = ProfileId(unique("profile"));
        let id = unique("chan");
        let text_ctx = channel(Some("guild"), &id, ContextKind::Channel);
        let voice_ctx = channel(Some("guild"), &id, ContextKind::Voice);
        let other_guild = channel(Some("other"), &id, ContextKind::Channel);
        let now = Utc::now();

        log.append(&entry(&profile, &text_ctx, "text", now))
            .await
            .unwrap();
        log.append(&entry(&profile, &voice_ctx, "voice", now))
            .await
            .unwrap();
        log.append(&entry(&profile, &other_guild, "other", now))
            .await
            .unwrap();
        log.append(&entry(&other_profile, &text_ctx, "other profile", now))
            .await
            .unwrap();

        let got = log.recent(&profile, &text_ctx, 10).await.unwrap();
        assert_eq!(texts(&got), ["text"]);
        let got = log.recent(&other_profile, &text_ctx, 10).await.unwrap();
        assert_eq!(texts(&got), ["other profile"]);
        let empty = channel(Some("guild"), &unique("chan"), ContextKind::Channel);
        assert!(log.recent(&profile, &empty, 10).await.unwrap().is_empty());
    }

    pub async fn module_state(store: &Store) {
        let modules = &store.module_state;
        let a = ModuleId(unique("test.a"));
        let b = ModuleId(unique("test.b"));
        assert_eq!(modules.get(&a).await.unwrap(), None);

        modules.set(&a, false).await.unwrap();
        modules.set(&b, true).await.unwrap();
        assert_eq!(modules.get(&a).await.unwrap(), Some(false));
        modules.set(&a, true).await.unwrap();
        assert_eq!(modules.get(&a).await.unwrap(), Some(true));

        let list = modules.list().await.unwrap();
        assert_eq!(list.get(&a), Some(&true));
        assert_eq!(list.get(&b), Some(&true));
    }

    pub async fn persona_overrides(store: &Store) {
        let overrides = &store.persona_overrides;
        let profile = ProfileId(unique("profile"));
        let other = ProfileId(unique("profile"));
        assert!(overrides.current(&profile).await.unwrap().is_empty());
        assert!(
            overrides
                .history(&profile, "style")
                .await
                .unwrap()
                .is_empty()
        );

        assert_eq!(
            overrides
                .set(&profile, "style", "v1", "panel:owen")
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            overrides
                .set(&profile, "style", "v2", "discord:1")
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            overrides
                .set(&profile, "identity", "id", "panel:owen")
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            overrides
                .set(&other, "style", "else", "panel:owen")
                .await
                .unwrap(),
            1
        );

        let current = overrides.current(&profile).await.unwrap();
        assert_eq!(current.len(), 2);
        assert_eq!(current["style"], "v2");
        assert_eq!(current["identity"], "id");

        let history = overrides.history(&profile, "style").await.unwrap();
        let summary: Vec<_> = history
            .iter()
            .map(|o| (o.version, o.body.as_str(), o.edited_by.as_str()))
            .collect();
        assert_eq!(summary, [(1, "v1", "panel:owen"), (2, "v2", "discord:1")]);
        assert!(
            history
                .iter()
                .all(|o| o.profile == profile && o.key == "style")
        );
        assert!(history[0].edited_at <= history[1].edited_at);
    }

    pub async fn persona_overrides_concurrent(store: &Store) {
        let profile = ProfileId(unique("profile"));
        let tasks: Vec<_> = (0..8)
            .map(|i| {
                let store = store.clone();
                let profile = profile.clone();
                tokio::spawn(async move {
                    store
                        .persona_overrides
                        .set(&profile, "style", &format!("edit {i}"), "test")
                        .await
                        .unwrap()
                })
            })
            .collect();
        let mut versions = Vec::new();
        for task in tasks {
            versions.push(task.await.unwrap());
        }
        versions.sort_unstable();
        assert_eq!(versions, (1..=8).collect::<Vec<u32>>());
    }

    pub async fn people(store: &Store) {
        let people = &store.people;
        let owen = account(&unique("owen"));
        let other = account(&unique("other"));
        assert!(people.person_by_account(&owen).await.unwrap().is_none());

        let id = people.upsert_account(&owen, "Owen").await.unwrap();
        assert_eq!(people.upsert_account(&owen, "Owen L").await.unwrap(), id);
        let other_id = people.upsert_account(&other, "Someone").await.unwrap();
        assert_ne!(id, other_id);

        let person = people.person_by_account(&owen).await.unwrap().unwrap();
        assert_eq!(person.id, id);
        assert_eq!(person.display_name, "Owen");
        assert_eq!(person.accounts.len(), 1);
        let acc = &person.accounts[0];
        assert_eq!(acc.account, owen);
        assert_eq!(acc.display_name, "Owen L");
        assert!(acc.first_seen <= acc.last_seen);
    }

    pub async fn decision_log_recent(store: &Store) {
        let log = &store.decisions;
        let profile = ProfileId(unique("profile"));
        let other_profile = ProfileId(unique("profile"));
        let id = unique("chan");
        let a = channel(Some("guild"), &id, ContextKind::Channel);
        let b = channel(Some("guild"), &id, ContextKind::Voice);
        let t0 = Utc::now().trunc_subsecs(6);

        // Appended out of order.
        for (reason, ctx, secs) in [("a2", &a, 2), ("a1", &a, 1), ("b3", &b, 3), ("a4", &a, 4)] {
            log.append(&decision(
                &profile,
                ctx,
                reason,
                t0 + Duration::seconds(secs),
            ))
            .await
            .unwrap();
        }
        log.append(&decision(&other_profile, &a, "other", t0))
            .await
            .unwrap();

        let all = log.recent(&profile, None, 100).await.unwrap();
        assert_eq!(reasons(&all), ["a4", "b3", "a2", "a1"]);
        let last = log.recent(&profile, None, 2).await.unwrap();
        assert_eq!(reasons(&last), ["a4", "b3"]);
        let only_a = log.recent(&profile, Some(&a), 100).await.unwrap();
        assert_eq!(reasons(&only_a), ["a4", "a2", "a1"]);
        let only_b = log.recent(&profile, Some(&b), 100).await.unwrap();
        assert_eq!(reasons(&only_b), ["b3"]);
        assert!(log.recent(&profile, None, 0).await.unwrap().is_empty());
        let other = log.recent(&other_profile, None, 100).await.unwrap();
        assert_eq!(reasons(&other), ["other"]);
        let empty = channel(Some("guild"), &unique("chan"), ContextKind::Channel);
        assert!(
            log.recent(&profile, Some(&empty), 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    pub async fn decision_log_round_trip(store: &Store) {
        let log = &store.decisions;
        let profile = ProfileId(unique("profile"));
        let ctx = channel(None, &unique("dm"), ContextKind::Dm);
        let mut d = decision(&profile, &ctx, "被提到了", Utc::now());
        d.trace.respond = true;
        d.trace.score = 0.875;
        d.trace.reasons.push("direct message".to_owned());
        log.append(&d).await.unwrap();

        let got = log.recent(&profile, Some(&ctx), 10).await.unwrap();
        assert_eq!(got.len(), 1);
        let got = &got[0];
        assert_eq!(got.id, d.id);
        assert_eq!(got.profile, profile);
        assert_eq!(got.ts, d.ts.trunc_subsecs(6));
        assert_eq!(got.trace.turn, d.trace.turn);
        assert_eq!(got.trace.context, ctx);
        assert!(got.trace.respond);
        assert_eq!(got.trace.score, 0.875);
        assert_eq!(got.trace.reasons, d.trace.reasons);

        assert!(log.append(&d).await.is_err(), "duplicate id must fail");
    }

    pub async fn settings(store: &Store) {
        let settings = &store.settings;
        let profile = ProfileId(unique("profile"));
        let other = ProfileId(unique("profile"));
        assert_eq!(settings.get(&profile, "mode:general").await.unwrap(), None);
        assert!(settings.list(&profile, "").await.unwrap().is_empty());

        let chatty = json!({"mode": "chatty", "n": 2});
        settings
            .set(&profile, "mode:general", Some(json!("quiet")))
            .await
            .unwrap();
        settings
            .set(&profile, "mode:general", Some(chatty.clone()))
            .await
            .unwrap();
        settings
            .set(&profile, "mode:dm", Some(json!(null)))
            .await
            .unwrap();
        settings
            .set(&other, "mode:general", Some(json!("other")))
            .await
            .unwrap();
        assert_eq!(
            settings.get(&profile, "mode:general").await.unwrap(),
            Some(chatty)
        );
        assert_eq!(
            settings.get(&profile, "mode:dm").await.unwrap(),
            Some(json!(null))
        );

        // Deleting, also of a missing key, leaves other profiles alone.
        settings.set(&profile, "mode:dm", None).await.unwrap();
        settings.set(&profile, "mode:missing", None).await.unwrap();
        assert_eq!(settings.get(&profile, "mode:dm").await.unwrap(), None);
        assert_eq!(
            settings.get(&other, "mode:general").await.unwrap(),
            Some(json!("other"))
        );
    }

    pub async fn settings_list_prefix(store: &Store) {
        let settings = &store.settings;
        let profile = ProfileId(unique("profile"));
        let keys = [
            "mode:b", "mode:a", "mode_x", "modeX:y", "mo%de:1", "other", "MODE:c",
        ];
        for (i, key) in keys.into_iter().enumerate() {
            settings.set(&profile, key, Some(json!(i))).await.unwrap();
        }
        settings
            .set(&ProfileId(unique("profile")), "mode:z", Some(json!(0)))
            .await
            .unwrap();

        let mut listed = Vec::new();
        for prefix in ["mode:", "mode_", "mo%", "mo", "mode:a", "nothing", ""] {
            let list = settings.list(&profile, prefix).await.unwrap();
            listed.push(list.into_keys().collect::<Vec<_>>());
        }
        // `_` and `%` are literal, and matching is case-sensitive.
        assert_eq!(
            listed,
            [
                vec!["mode:a", "mode:b"],
                vec!["mode_x"],
                vec!["mo%de:1"],
                vec!["mo%de:1", "mode:a", "mode:b", "modeX:y", "mode_x"],
                vec!["mode:a"],
                vec![],
                vec![
                    "MODE:c", "mo%de:1", "mode:a", "mode:b", "modeX:y", "mode_x", "other"
                ],
            ]
        );

        let list = settings.list(&profile, "mode:").await.unwrap();
        assert_eq!(list["mode:a"], json!(1));
        assert_eq!(list["mode:b"], json!(0));
    }

    pub async fn from_url_memory(_store: &Store) {
        let store = Store::from_url("memory://").await.unwrap();
        assert!(store.module_state.list().await.unwrap().is_empty());
    }
}

async fn postgres() -> Option<Store> {
    match std::env::var(DB_ENV) {
        Ok(url) if !url.is_empty() => Some(
            Store::from_url(&url)
                .await
                .expect("cannot open the test database"),
        ),
        _ => {
            eprintln!("skipping PostgreSQL test: {DB_ENV} is not set");
            None
        }
    }
}

macro_rules! suite {
    ($($case:ident),* $(,)?) => {
        mod memory {
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
                async fn $case() {
                    super::cases::$case(&miyoria_store::Store::memory()).await;
                }
            )*
        }

        mod postgres {
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
                async fn $case() {
                    if let Some(store) = super::postgres().await {
                        super::cases::$case(&store).await;
                    }
                }
            )*
        }
    };
}

suite!(
    message_log_recent,
    message_log_round_trip,
    message_log_isolation,
    module_state,
    persona_overrides,
    persona_overrides_concurrent,
    people,
    decision_log_recent,
    decision_log_round_trip,
    settings,
    settings_list_prefix,
    from_url_memory,
);

/// The memory backend keeps only the newest decisions of each profile.
#[tokio::test]
async fn memory_decision_log_cap() {
    const CAP: usize = 10_000;
    let store = Store::memory();
    let profile = ProfileId(unique("profile"));
    let ctx = channel(Some("guild"), "chan", ContextKind::Channel);
    let t0 = Utc::now().trunc_subsecs(6);
    for i in 0..=CAP {
        let ts = t0 + Duration::seconds(i64::try_from(i).unwrap());
        store
            .decisions
            .append(&decision(&profile, &ctx, &i.to_string(), ts))
            .await
            .unwrap();
    }

    let all = store
        .decisions
        .recent(&profile, None, usize::MAX)
        .await
        .unwrap();
    assert_eq!(all.len(), CAP);
    assert_eq!(all[0].trace.reasons[0], CAP.to_string());
    assert_eq!(all[CAP - 1].trace.reasons[0], "1");
}
