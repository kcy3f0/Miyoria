use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use miyoria_queue::{
    Clock, ItemState, QueueConfig, QueueError, RequestQueue, STATE_KEY, STATE_PROFILE,
    SubmitRequest,
};
use miyoria_store::SettingsStore;
use miyoria_types::{AccountRef, Attitude, Event, PersonId, PlatformId, ProfileId, SocialSignals};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

fn acct(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: id.to_owned(),
    }
}

/// Every call advances 1 ms so items and ballots have distinct times;
/// `advance` jumps further.
#[derive(Clone)]
struct TestClock(Arc<AtomicI64>);

impl TestClock {
    fn new() -> Self {
        Self(Arc::new(AtomicI64::new(0)))
    }

    fn clock(&self) -> Clock {
        let ms = self.0.clone();
        Arc::new(move || -> DateTime<Utc> {
            let t = ms.fetch_add(1, Ordering::SeqCst);
            Utc.timestamp_millis_opt(1_700_000_000_000 + t).unwrap()
        })
    }

    fn advance(&self, secs: i64) {
        self.0.fetch_add(secs * 1000, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeSocial {
    affinity: HashMap<AccountRef, f32>,
    blocked: HashSet<AccountRef>,
}

impl SocialSignals for FakeSocial {
    fn attitude(&self, account: &AccountRef) -> Option<Attitude> {
        let affinity = *self.affinity.get(account)?;
        Some(Attitude {
            person: PersonId::new(),
            affinity,
            trust: 0.0,
            familiarity: 0.0,
            blocked: self.blocked.contains(account),
            label: String::new(),
            call_name: None,
        })
    }
}

#[derive(Default)]
struct FakeStore {
    data: Mutex<BTreeMap<(String, String), serde_json::Value>>,
    writes: Mutex<usize>,
}

#[async_trait]
impl SettingsStore for FakeStore {
    async fn get(
        &self,
        profile: &ProfileId,
        key: &str,
    ) -> anyhow::Result<Option<serde_json::Value>> {
        Ok(self
            .data
            .lock()
            .get(&(profile.to_string(), key.to_owned()))
            .cloned())
    }

    async fn set(
        &self,
        profile: &ProfileId,
        key: &str,
        value: Option<serde_json::Value>,
    ) -> anyhow::Result<()> {
        *self.writes.lock() += 1;
        let k = (profile.to_string(), key.to_owned());
        match value {
            Some(v) => self.data.lock().insert(k, v),
            None => self.data.lock().remove(&k),
        };
        Ok(())
    }

    async fn list(
        &self,
        profile: &ProfileId,
        prefix: &str,
    ) -> anyhow::Result<BTreeMap<String, serde_json::Value>> {
        Ok(self
            .data
            .lock()
            .iter()
            .filter(|((p, k), _)| p == profile.as_str() && k.starts_with(prefix))
            .map(|((_, k), v)| (k.clone(), v.clone()))
            .collect())
    }
}

fn queue_with(config: QueueConfig, clock: &TestClock) -> RequestQueue {
    RequestQueue::new(config).with_clock(clock.clock())
}

fn req(who: &str, text: &str) -> SubmitRequest {
    SubmitRequest::new(acct(who), format!("user{who}"), "chat", text)
}

fn texts(q: &RequestQueue) -> Vec<String> {
    q.list().into_iter().map(|i| i.text).collect()
}

#[test]
fn fair_round_robin_across_requesters() {
    let q = queue_with(QueueConfig::default(), &TestClock::new());
    q.submit(req("a", "a1")).unwrap();
    q.submit(req("a", "a2")).unwrap();
    q.submit(req("b", "b1")).unwrap();
    q.submit(req("c", "c1")).unwrap();
    assert_eq!(texts(&q), ["a1", "b1", "c1", "a2"]);

    // A already had a turn: B and C go before A's next one.
    assert_eq!(q.next().unwrap().text, "a1");
    q.submit(req("a", "a3")).unwrap();
    assert_eq!(texts(&q), ["a1", "b1", "c1", "a2", "a3"]);
    assert_eq!(q.next().unwrap().text, "b1");
    assert_eq!(q.next().unwrap().text, "c1");
    assert_eq!(q.next().unwrap().text, "a2");
    assert_eq!(q.next().unwrap().text, "a3");
    assert!(q.next().is_none());
}

#[test]
fn newcomers_start_level_with_waiting_requesters() {
    let q = queue_with(QueueConfig::default(), &TestClock::new());
    for n in 0..4 {
        q.submit(req("a", &format!("a{n}"))).unwrap();
        q.next().unwrap();
    }
    // C and B arrive while A (served 4 times) waits.
    q.submit(req("a", "a-next")).unwrap();
    q.submit(req("c", "c1")).unwrap();
    q.submit(req("b", "b1")).unwrap();
    // Newcomers neither queue behind A's served history nor jump ahead of
    // A's older item: they start level with A and age decides.
    assert_eq!(q.next().unwrap().text, "a-next");
    assert_eq!(q.next().unwrap().text, "c1");
    assert_eq!(q.next().unwrap().text, "b1");
}

#[test]
fn per_user_cap_and_validation() {
    let q = queue_with(QueueConfig::default(), &TestClock::new());
    q.submit(req("a", "1")).unwrap();
    q.submit(req("a", "2")).unwrap();
    assert_eq!(
        q.submit(req("a", "3")).unwrap_err(),
        QueueError::UserLimit(2)
    );
    // Another user is unaffected, and an active item no longer counts as pending.
    q.submit(req("b", "x")).unwrap();
    q.next().unwrap();
    q.submit(req("a", "3")).unwrap();

    assert_eq!(q.submit(req("z", "  ")).unwrap_err(), QueueError::EmptyText);
    let long = "あ".repeat(201);
    assert_eq!(
        q.submit(req("z", &long)).unwrap_err(),
        QueueError::TextTooLong(200)
    );

    let small = queue_with(
        QueueConfig {
            max_pending: 2,
            ..QueueConfig::default()
        },
        &TestClock::new(),
    );
    small.submit(req("a", "1")).unwrap();
    small.submit(req("b", "2")).unwrap();
    assert_eq!(
        small.submit(req("c", "3")).unwrap_err(),
        QueueError::QueueFull(2)
    );
}

#[test]
fn kind_is_normalized() {
    let q = queue_with(QueueConfig::default(), &TestClock::new());
    let s = q
        .submit(SubmitRequest::new(acct("a"), "a", " Song ", "x"))
        .unwrap();
    assert_eq!(s.item.kind, "song");
    let s = q
        .submit(SubmitRequest::new(acct("b"), "b", "", "y"))
        .unwrap();
    assert_eq!(s.item.kind, "chat");
}

#[test]
fn affinity_weights_within_a_round_and_blocked_is_refused() {
    let mut social = FakeSocial::default();
    social.affinity.insert(acct("friend"), 80.0);
    social.affinity.insert(acct("stranger"), 0.0);
    social.affinity.insert(acct("rival"), -50.0);
    social.affinity.insert(acct("pest"), -100.0);
    social.blocked.insert(acct("pest"));
    let q =
        queue_with(QueueConfig::default(), &TestClock::new()).with_social(Some(Arc::new(social)));

    // The rival asked first, the friend last; weight reorders within the lap.
    q.submit(req("rival", "rival")).unwrap();
    q.submit(req("stranger", "stranger")).unwrap();
    let s = q.submit(req("friend", "friend")).unwrap();
    assert_eq!(s.position, 1);
    assert_eq!(texts(&q), ["friend", "stranger", "rival"]);
    assert_eq!(
        q.submit(req("pest", "hi")).unwrap_err(),
        QueueError::Blocked
    );

    // Affinity does not beat fairness: the friend's second item waits.
    q.submit(req("friend", "friend2")).unwrap();
    assert_eq!(texts(&q), ["friend", "stranger", "rival", "friend2"]);
}

#[test]
fn upvotes_add_weight_once_per_account() {
    let q = queue_with(QueueConfig::default(), &TestClock::new());
    let a = q.submit(req("a", "a")).unwrap().item.id;
    let b = q.submit(req("b", "b")).unwrap().item.id;
    assert_eq!(q.vote(b, &acct("x")).unwrap(), 1);
    assert_eq!(q.vote(b, &acct("x")).unwrap(), 1);
    assert_eq!(q.vote(b, &acct("y")).unwrap(), 2);
    assert_eq!(texts(&q), ["b", "a"]);
    assert_eq!(
        q.vote(99, &acct("x")).unwrap_err(),
        QueueError::NotFound(99)
    );
    q.next().unwrap();
    q.next().unwrap();
    assert_eq!(
        q.vote(a, &acct("x")).unwrap_err(),
        QueueError::WrongState(a)
    );
}

#[test]
fn priority_and_move() {
    let q = queue_with(QueueConfig::default(), &TestClock::new());
    let a = q.submit(req("a", "a")).unwrap().item.id;
    let b = q.submit(req("b", "b")).unwrap().item.id;
    let c = q.submit(req("c", "c")).unwrap().item.id;
    let d = q.submit(req("d", "d")).unwrap().item.id;
    assert_eq!(texts(&q), ["a", "b", "c", "d"]);

    q.set_priority(c, 5).unwrap();
    assert_eq!(texts(&q), ["c", "a", "b", "d"]);

    q.move_item(d, 0).unwrap();
    assert_eq!(texts(&q), ["d", "c", "a", "b"]);
    q.move_item(d, 2).unwrap();
    assert_eq!(texts(&q), ["c", "a", "d", "b"]);
    q.move_item(c, 99).unwrap();
    assert_eq!(texts(&q), ["a", "d", "b", "c"]);
    q.move_item(b, 1).unwrap();
    assert_eq!(texts(&q), ["a", "b", "d", "c"]);

    // The order is what `next` hands out.
    assert_eq!(q.next().unwrap().id, a);
    assert_eq!(q.next().unwrap().id, b);
    assert_eq!(q.next().unwrap().id, d);
    assert_eq!(q.next().unwrap().id, c);
    assert_eq!(q.set_priority(a, 1).unwrap_err(), QueueError::WrongState(a));
    assert_eq!(q.move_item(42, 0).unwrap_err(), QueueError::NotFound(42));
}

#[test]
fn pause_blocks_next_but_not_submit() {
    let q = queue_with(QueueConfig::default(), &TestClock::new());
    q.pause();
    assert!(q.is_paused());
    q.submit(req("a", "a")).unwrap();
    assert!(q.next().is_none());
    q.resume();
    assert!(!q.is_paused());
    assert_eq!(q.next().unwrap().text, "a");
}

#[test]
fn lifecycle_states_and_history() {
    let q = queue_with(
        QueueConfig {
            history_limit: 3,
            ..QueueConfig::default()
        },
        &TestClock::new(),
    );
    let ids: Vec<_> = ["a", "b", "c", "d", "e"]
        .iter()
        .map(|w| q.submit(req(w, w)).unwrap().item.id)
        .collect();
    assert_eq!(
        q.complete(ids[0]).unwrap_err(),
        QueueError::WrongState(ids[0])
    );
    let first = q.next().unwrap();
    assert_eq!(first.id, ids[0]);
    assert_eq!(q.current().unwrap().id, ids[0]);
    assert_eq!(q.complete(ids[0]).unwrap().state, ItemState::Done);
    assert_eq!(q.skip(ids[1]).unwrap().state, ItemState::Skipped);
    assert_eq!(q.remove(ids[2]).unwrap().state, ItemState::Removed);
    assert_eq!(q.clear(), 2);
    assert!(q.list().is_empty());
    assert_eq!(q.clear(), 0);
    // Only the last 3 finished items are kept.
    let history = q.history();
    assert_eq!(history.len(), 3);
    assert_eq!(history[0].id, ids[2]);
    assert_eq!(q.get(ids[4]).unwrap().state, ItemState::Removed);
    assert!(q.get(ids[0]).is_none());
    assert_eq!(q.remove(ids[4]).unwrap_err(), QueueError::NotFound(ids[4]));
}

#[test]
fn clear_keeps_active_items() {
    let q = queue_with(QueueConfig::default(), &TestClock::new());
    q.submit(req("a", "a")).unwrap();
    q.submit(req("b", "b")).unwrap();
    q.next().unwrap();
    assert_eq!(q.clear(), 1);
    assert_eq!(texts(&q), ["a"]);
    assert_eq!(q.list()[0].state, ItemState::Active);
}

#[test]
fn voting_latest_ballot_wins_and_ties_go_to_the_earliest() {
    let clock = TestClock::new();
    let q = queue_with(QueueConfig::default(), &clock);
    assert_eq!(
        q.cast_vote(&acct("a"), "x").unwrap_err(),
        QueueError::NoVote
    );
    assert!(matches!(
        q.start_vote(vec!["only".into()], Duration::from_secs(10)),
        Err(QueueError::BadVote(_))
    ));
    assert!(matches!(
        q.start_vote(vec!["a".into(), "A".into()], Duration::from_secs(10)),
        Err(QueueError::BadVote(_))
    ));
    q.start_vote(
        vec!["左".into(), "右".into(), "上".into()],
        Duration::from_secs(30),
    )
    .unwrap();
    assert_eq!(
        q.start_vote(vec!["a".into(), "b".into()], Duration::from_secs(5))
            .unwrap_err(),
        QueueError::VoteRunning
    );

    assert_eq!(q.cast_vote(&acct("1"), "左").unwrap(), "左");
    assert_eq!(q.cast_vote(&acct("2"), "2").unwrap(), "右");
    assert_eq!(q.cast_vote(&acct("3"), "上").unwrap(), "上");
    assert!(matches!(
        q.cast_vote(&acct("3"), "下").unwrap_err(),
        QueueError::UnknownOption(_)
    ));
    assert_eq!(q.vote_status().unwrap().tallies(), [1, 1, 1]);

    // Account 1 changes their mind: the latest ballot replaces the old one.
    q.cast_vote(&acct("1"), "右").unwrap();
    assert_eq!(q.vote_status().unwrap().tallies(), [0, 2, 1]);

    // Tie 2-2 between 右 and 上: 右 reached its second vote first, so it wins.
    q.cast_vote(&acct("4"), "上").unwrap();
    assert_eq!(q.vote_status().unwrap().tallies(), [0, 2, 2]);
    let early = q.end_vote().unwrap();
    assert_eq!(early.winner_option(), Some("右"));
    assert_eq!(early.total, 4);
    assert!(q.vote_status().is_none());

    // The reverse order flips the tie.
    q.start_vote(vec!["左".into(), "右".into()], Duration::from_secs(30))
        .unwrap();
    q.cast_vote(&acct("1"), "右").unwrap();
    q.cast_vote(&acct("2"), "左").unwrap();
    q.cast_vote(&acct("3"), "左").unwrap();
    q.cast_vote(&acct("4"), "右").unwrap();
    assert_eq!(q.end_vote().unwrap().winner_option(), Some("左"));
}

#[test]
fn vote_expires_via_tick_and_enqueues_the_winner() {
    let clock = TestClock::new();
    let q = queue_with(QueueConfig::default(), &clock);
    q.start_vote(
        vec!["挖鑽石".into(), "蓋房子".into()],
        Duration::from_secs(10),
    )
    .unwrap();
    q.cast_vote(&acct("1"), "蓋房子").unwrap();
    q.cast_vote(&acct("2"), "蓋房子").unwrap();
    q.cast_vote(&acct("3"), "挖鑽石").unwrap();
    assert!(q.tick().is_none());

    clock.advance(11);
    // Ballots after the deadline are refused even before the tick closes it.
    assert_eq!(
        q.cast_vote(&acct("9"), "挖鑽石").unwrap_err(),
        QueueError::NoVote
    );
    let result = q.tick().unwrap();
    assert_eq!(result.winner_option(), Some("蓋房子"));
    assert_eq!(result.tallies, [1, 2]);
    assert_eq!(q.last_vote(), Some(result));
    assert!(q.tick().is_none());

    let item = q.next().unwrap();
    assert_eq!((item.kind.as_str(), item.text.as_str()), ("vote", "蓋房子"));
    assert_eq!(item.priority, 100);
}

#[test]
fn vote_without_ballots_has_no_winner() {
    let q = queue_with(QueueConfig::default(), &TestClock::new());
    q.start_vote(vec!["a".into(), "b".into()], Duration::from_secs(5))
        .unwrap();
    let result = q.end_vote().unwrap();
    assert_eq!(result.winner, None);
    assert!(q.list().is_empty());
    assert_eq!(q.end_vote().unwrap_err(), QueueError::NoVote);
}

#[test]
fn publishes_events() {
    let events: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::default();
    let sink = events.clone();
    let q = queue_with(QueueConfig::default(), &TestClock::new()).with_publisher(Arc::new(
        move |event| {
            if let Event::Custom { topic, payload } = event {
                sink.lock().push((topic, payload));
            }
        },
    ));
    q.submit(req("a", "唱歌")).unwrap();
    q.pause();
    q.pause(); // no change, no event
    q.resume();
    q.next().unwrap();
    q.start_vote(vec!["a".into(), "b".into()], Duration::from_secs(5))
        .unwrap();
    q.cast_vote(&acct("1"), "a").unwrap();
    q.end_vote().unwrap();

    let events = events.lock();
    let topics: Vec<&str> = events.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(
        topics,
        [
            "queue.changed", // submit
            "queue.changed", // pause
            "queue.changed", // resume
            "queue.changed", // next
            "queue.item_activated",
            "queue.changed", // start_vote
            "queue.changed", // cast_vote
            "queue.changed", // end_vote
            "queue.vote_result",
        ]
    );
    let submit = &events[0].1;
    assert_eq!(submit["paused"], false);
    assert_eq!(submit["items"][0]["text"], "唱歌");
    assert_eq!(submit["items"][0]["position"], 1);
    assert_eq!(submit["items"][0]["requester"]["id"], "a");
    assert!(submit.get("vote").is_none());
    assert_eq!(events[1].1["paused"], true);
    assert_eq!(events[4].1["state"], "active");
    assert_eq!(events[4].1["text"], "唱歌");
    let during_vote = &events[6].1;
    assert_eq!(
        during_vote["vote"]["options"],
        serde_json::json!(["a", "b"])
    );
    assert_eq!(during_vote["vote"]["tallies"], serde_json::json!([1, 0]));
    assert_eq!(events[8].1["winner_option"], "a");
    // The winner was enqueued, so the last changed event lists it.
    assert_eq!(events[7].1["items"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn persistence_round_trip() {
    let store = Arc::new(FakeStore::default());
    let clock = TestClock::new();
    let q = queue_with(QueueConfig::default(), &clock)
        .with_store(Some(store.clone() as Arc<dyn SettingsStore>));
    assert!(!q.restore().await.unwrap());

    q.submit(req("a", "a1")).unwrap();
    q.submit(req("a", "a2")).unwrap();
    let b = q.submit(req("b", "b1")).unwrap().item.id;
    q.submit(req("d", "d1")).unwrap();
    q.next().unwrap(); // a1 active, A has been served once
    q.vote(b, &acct("x")).unwrap();
    q.set_priority(b, 3).unwrap();
    q.pause();
    q.start_vote(vec!["x".into(), "y".into()], Duration::from_secs(60))
        .unwrap();
    q.cast_vote(&acct("1"), "y").unwrap();
    q.skip(b).unwrap();
    q.persist().await.unwrap();

    let stored = store
        .get(&ProfileId::from(STATE_PROFILE), STATE_KEY)
        .await
        .unwrap();
    assert!(stored.is_some());

    let revived = queue_with(QueueConfig::default(), &clock)
        .with_store(Some(store.clone() as Arc<dyn SettingsStore>));
    assert!(revived.restore().await.unwrap());
    assert_eq!(revived.list(), q.list());
    assert_eq!(revived.history(), q.history());
    assert!(revived.is_paused());
    assert_eq!(revived.vote_status(), q.vote_status());
    assert_eq!(revived.current().unwrap().text, "a1");

    // Fairness credit survives (d1 is newer than a2 but goes first, as A was
    // already served) and so does the id counter.
    assert_eq!(texts(&revived), ["a1", "d1", "a2"]);
    revived.resume();
    let c = revived.submit(req("c", "c1")).unwrap();
    assert!(c.item.id > b);
    assert_eq!(revived.next().unwrap().text, "d1");
    assert_eq!(revived.next().unwrap().text, "c1");
    assert_eq!(revived.next().unwrap().text, "a2");
}

#[tokio::test]
async fn corrupt_snapshot_is_an_error_and_leaves_the_queue_alone() {
    let store = Arc::new(FakeStore::default());
    store
        .set(
            &ProfileId::from(STATE_PROFILE),
            STATE_KEY,
            Some(serde_json::json!({ "items": "nope" })),
        )
        .await
        .unwrap();
    let q = queue_with(QueueConfig::default(), &TestClock::new())
        .with_store(Some(store as Arc<dyn SettingsStore>));
    q.submit(req("a", "a")).unwrap();
    assert!(q.restore().await.is_err());
    assert_eq!(texts(&q), ["a"]);
}

#[tokio::test]
async fn run_loop_saves_debounced_closes_votes_and_flushes_on_cancel() {
    let store = Arc::new(FakeStore::default());
    let config = QueueConfig {
        persist_debounce_ms: 60,
        tick_ms: 10,
        ..QueueConfig::default()
    };
    let q = Arc::new(
        RequestQueue::new(config).with_store(Some(store.clone() as Arc<dyn SettingsStore>)),
    );
    let cancel = CancellationToken::new();
    let task = tokio::spawn({
        let q = q.clone();
        let cancel = cancel.clone();
        async move { q.run(cancel).await }
    });

    // A burst of changes becomes one write.
    for n in 0..5 {
        q.submit(req(&n.to_string(), "x")).unwrap();
    }
    assert_eq!(*store.writes.lock(), 0);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(*store.writes.lock(), 1);

    // A one second vote is closed by the loop on its own.
    q.start_vote(vec!["a".into(), "b".into()], Duration::from_secs(1))
        .unwrap();
    q.cast_vote(&acct("1"), "a").unwrap();
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert!(q.vote_status().is_none());
    assert_eq!(q.last_vote().unwrap().winner_option(), Some("a"));

    // A change right before shutdown is flushed.
    q.pause();
    cancel.cancel();
    task.await.unwrap();
    let stored = store
        .get(&ProfileId::from(STATE_PROFILE), STATE_KEY)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored["paused"], true);
}
