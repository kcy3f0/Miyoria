//! One behaviour suite, run against every backend.
//!
//! The memory backend always runs. The PostgreSQL backend runs only when
//! `MIYORIA_TEST_DATABASE_URL` is set; otherwise its tests pass with a skip
//! message. Every case uses fresh ids, so it can share a database with other
//! runs.

use chrono::{DateTime, Duration, SubsecRound, Utc};
use miyoria_store::{
    AuditEntry, AuthScope, DecisionRecord, LogEntry, MemoryFilter, MemoryHit, MemoryKind,
    MemoryQuery, MemoryRecord, MemoryScope, NodeOverride, PrunePolicy, Relationship,
    RelationshipDelta, RoleAssignment, RoleDefinition, RoleMapping, Store,
};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, DecisionTrace, ModuleId, PersonId, PlatformId, ProfileId,
    TurnId,
};
use serde_json::json;
use std::collections::BTreeSet;
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

// ---------------------------------------------------------------------------
// Memory records
// ---------------------------------------------------------------------------

fn now_micros() -> DateTime<Utc> {
    Utc::now().trunc_subsecs(6)
}

fn memory(
    profile: &ProfileId,
    kind: MemoryKind,
    scope: MemoryScope,
    tokens: &str,
    created_at: DateTime<Utc>,
) -> MemoryRecord {
    MemoryRecord {
        id: Ulid::new(),
        profile: profile.clone(),
        kind,
        scope,
        subjects: Vec::new(),
        content: format!("content of {tokens}"),
        tokens: tokens.to_owned(),
        embedding: None,
        importance: 0.5,
        confidence: 0.75,
        created_at,
        updated_at: created_at,
        last_accessed: None,
        access_count: 0,
        source_context: None,
        due: None,
        done: false,
        superseded_by: None,
    }
}

fn guild_scope(guild: &str) -> MemoryScope {
    MemoryScope::Guild {
        platform: PlatformId::new("discord"),
        guild: guild.to_owned(),
    }
}

fn text_query(
    profile: &ProfileId,
    scopes: Vec<MemoryScope>,
    tokens: &[&str],
    limit: usize,
) -> MemoryQuery {
    MemoryQuery {
        profile: profile.clone(),
        scopes,
        kinds: None,
        tokens: tokens.iter().map(|t| (*t).to_owned()).collect(),
        embedding: None,
        limit,
    }
}

fn hit_ids(hits: &[MemoryHit]) -> BTreeSet<Ulid> {
    hits.iter().map(|h| h.record.id).collect()
}

fn id_set(records: &[&MemoryRecord]) -> BTreeSet<Ulid> {
    records.iter().map(|r| r.id).collect()
}

fn record_ids(records: &[MemoryRecord]) -> Vec<Ulid> {
    records.iter().map(|r| r.id).collect()
}

fn near(a: f32, b: f32) -> bool {
    (a - b).abs() < 1e-4
}

mod memory_cases {
    use super::*;

    pub async fn memory_round_trip(store: &Store) {
        let memories = &store.memories;
        let profile = ProfileId(unique("profile"));
        let t0 = now_micros();
        let mut r = memory(
            &profile,
            MemoryKind::Fact,
            MemoryScope::Person {
                person: PersonId::new(),
            },
            "owen ramen",
            t0,
        );
        r.content = "Owen 喜歡拉麵".to_owned();
        r.subjects = vec![PersonId::new(), PersonId::new()];
        r.embedding = Some(vec![0.25, -0.5, 1.5]);
        r.importance = 0.875;
        r.last_accessed = Some(t0 + Duration::seconds(5));
        r.access_count = 3;
        r.source_context = Some(channel(Some("guild"), &unique("chan"), ContextKind::Voice));
        r.due = Some(t0 + Duration::hours(1));
        memories.upsert(&r).await.unwrap();
        assert_eq!(memories.get(r.id).await.unwrap(), Some(r.clone()));

        // Upsert replaces the whole record.
        r.content = "changed".to_owned();
        r.embedding = None;
        r.done = true;
        r.superseded_by = Some(Ulid::new());
        r.scope = MemoryScope::Global;
        memories.upsert(&r).await.unwrap();
        assert_eq!(memories.get(r.id).await.unwrap(), Some(r.clone()));

        assert!(memories.delete(r.id).await.unwrap());
        assert!(!memories.delete(r.id).await.unwrap());
        assert_eq!(memories.get(r.id).await.unwrap(), None);
        assert_eq!(memories.get(Ulid::new()).await.unwrap(), None);

        // Sub-microsecond precision is dropped, and an empty embedding means
        // "none".
        let mut precise = memory(&profile, MemoryKind::Episode, MemoryScope::Global, "x", t0);
        precise.created_at = t0 + Duration::nanoseconds(789);
        precise.embedding = Some(Vec::new());
        memories.upsert(&precise).await.unwrap();
        let got = memories.get(precise.id).await.unwrap().unwrap();
        assert_eq!(got.created_at, t0);
        assert_eq!(got.embedding, None);

        let mut bad = memory(&profile, MemoryKind::Episode, MemoryScope::Global, "x", t0);
        bad.embedding = Some(vec![1.0, f32::NAN]);
        assert!(memories.upsert(&bad).await.is_err());
    }

    pub async fn memory_search_scopes(store: &Store) {
        let memories = &store.memories;
        let profile = ProfileId(unique("profile"));
        let other_profile = ProfileId(unique("profile"));
        let t0 = now_micros();
        let chan_id = unique("chan");
        let scopes = [
            ("global", MemoryScope::Global),
            ("guild", guild_scope(&unique("g"))),
            ("other_guild", guild_scope(&unique("g"))),
            (
                "channel",
                MemoryScope::Channel {
                    context: channel(Some("g"), &chan_id, ContextKind::Channel),
                },
            ),
            (
                "voice",
                MemoryScope::Channel {
                    context: channel(Some("g"), &chan_id, ContextKind::Voice),
                },
            ),
            (
                "dm",
                MemoryScope::Dm {
                    account: account(&unique("a")),
                },
            ),
            (
                "person",
                MemoryScope::Person {
                    person: PersonId::new(),
                },
            ),
        ];
        let mut by_name = std::collections::BTreeMap::new();
        for (i, (name, scope)) in scopes.iter().enumerate() {
            let kind = if i % 2 == 0 {
                MemoryKind::Fact
            } else {
                MemoryKind::Episode
            };
            let r = memory(
                &profile,
                kind,
                scope.clone(),
                "ramen shop",
                t0 + Duration::seconds(i as i64),
            );
            memories.upsert(&r).await.unwrap();
            by_name.insert(*name, r);
        }
        let foreign = memory(
            &other_profile,
            MemoryKind::Fact,
            MemoryScope::Global,
            "ramen shop",
            t0,
        );
        memories.upsert(&foreign).await.unwrap();
        let scope_of = |name: &str| by_name[name].scope.clone();

        let hits = memories
            .search(&text_query(
                &profile,
                vec![scope_of("global"), scope_of("guild")],
                &["ramen"],
                10,
            ))
            .await
            .unwrap();
        assert_eq!(
            hit_ids(&hits),
            id_set(&[&by_name["global"], &by_name["guild"]])
        );
        assert!(hits.iter().all(|h| h.text_score > 0.0));
        assert!(hits.iter().all(|h| h.vector_score.is_none()));

        // A channel scope is not its voice counterpart, a guild is not
        // another guild.
        let hits = memories
            .search(&text_query(
                &profile,
                vec![scope_of("channel")],
                &["ramen"],
                10,
            ))
            .await
            .unwrap();
        assert_eq!(hit_ids(&hits), id_set(&[&by_name["channel"]]));
        let hits = memories
            .search(&text_query(
                &profile,
                vec![scope_of("voice")],
                &["ramen"],
                10,
            ))
            .await
            .unwrap();
        assert_eq!(hit_ids(&hits), id_set(&[&by_name["voice"]]));

        // Every scope listed: all of this profile's records, none of the
        // other profile's.
        let all_scopes: Vec<_> = scopes.iter().map(|(_, s)| s.clone()).collect();
        let hits = memories
            .search(&text_query(&profile, all_scopes.clone(), &["ramen"], 100))
            .await
            .unwrap();
        assert_eq!(hits.len(), scopes.len());
        assert!(!hit_ids(&hits).contains(&foreign.id));

        // Nothing listed, nothing found; limit caps text hits.
        assert!(
            memories
                .search(&text_query(&profile, Vec::new(), &["ramen"], 10))
                .await
                .unwrap()
                .is_empty()
        );
        let hits = memories
            .search(&text_query(&profile, all_scopes.clone(), &["ramen"], 3))
            .await
            .unwrap();
        assert_eq!(hits.len(), 3);
        assert!(
            memories
                .search(&text_query(&profile, all_scopes.clone(), &["ramen"], 0))
                .await
                .unwrap()
                .is_empty()
        );

        // Kinds restrict; matching ignores case; no tokens and no embedding
        // find nothing; unknown tokens find nothing.
        let mut q = text_query(&profile, all_scopes.clone(), &["RAMEN"], 100);
        q.kinds = Some(vec![MemoryKind::Episode]);
        let hits = memories.search(&q).await.unwrap();
        assert_eq!(hits.len(), 3);
        assert!(hits.iter().all(|h| h.record.kind == MemoryKind::Episode));
        q.kinds = Some(Vec::new());
        assert!(memories.search(&q).await.unwrap().is_empty());
        assert!(
            memories
                .search(&text_query(&profile, all_scopes.clone(), &[], 10))
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            memories
                .search(&text_query(&profile, all_scopes, &["sushi"], 10))
                .await
                .unwrap()
                .is_empty()
        );
    }

    pub async fn memory_search_superseded(store: &Store) {
        let memories = &store.memories;
        let profile = ProfileId(unique("profile"));
        let t0 = now_micros();
        let mut old = memory(&profile, MemoryKind::Fact, MemoryScope::Global, "ramen", t0);
        old.embedding = Some(vec![1.0, 0.0]);
        let mut new = memory(&profile, MemoryKind::Fact, MemoryScope::Global, "ramen", t0);
        new.embedding = Some(vec![1.0, 0.0]);
        memories.upsert(&old).await.unwrap();
        memories.upsert(&new).await.unwrap();

        let mut q = text_query(&profile, vec![MemoryScope::Global], &["ramen"], 10);
        q.embedding = Some(vec![1.0, 0.0]);
        assert_eq!(hit_ids(&memories.search(&q).await.unwrap()).len(), 2);

        old.superseded_by = Some(new.id);
        memories.upsert(&old).await.unwrap();
        let hits = memories.search(&q).await.unwrap();
        assert_eq!(hit_ids(&hits), BTreeSet::from([new.id]));

        // Still stored, and listed on request.
        assert_eq!(memories.get(old.id).await.unwrap(), Some(old.clone()));
        let filter = MemoryFilter {
            limit: 10,
            ..MemoryFilter::default()
        };
        let listed = memories.list(&profile, &filter).await.unwrap();
        assert_eq!(record_ids(&listed), [new.id]);
        let filter = MemoryFilter {
            include_superseded: true,
            ..filter
        };
        let listed = memories.list(&profile, &filter).await.unwrap();
        assert_eq!(listed.len(), 2);
    }

    pub async fn memory_search_vector_and_text(store: &Store) {
        let memories = &store.memories;
        let profile = ProfileId(unique("profile"));
        let other_profile = ProfileId(unique("profile"));
        let t0 = now_micros();
        let scope = guild_scope(&unique("g"));
        let mk = |tokens: &str, embedding: Option<Vec<f32>>, secs: i64| {
            let mut r = memory(
                &profile,
                MemoryKind::Fact,
                scope.clone(),
                tokens,
                t0 + Duration::seconds(secs),
            );
            r.embedding = embedding;
            r
        };
        let both = mk("ramen noodles", Some(vec![1.0, 0.0, 0.0]), 1);
        let text_only = mk("ramen", Some(vec![0.0, 1.0, 0.0]), 2);
        let vector_only = mk("sushi", Some(vec![0.9, 0.1, 0.0]), 3);
        let other_dims = mk("sushi", Some(vec![1.0, 0.0]), 4);
        let no_embedding = mk("cat", None, 5);
        let other_scope = {
            let mut r = mk("ramen", Some(vec![1.0, 0.0, 0.0]), 6);
            r.scope = guild_scope(&unique("g"));
            r
        };
        let mut foreign = mk("ramen", Some(vec![1.0, 0.0, 0.0]), 7);
        foreign.profile = other_profile;
        for r in [
            &both,
            &text_only,
            &vector_only,
            &other_dims,
            &no_embedding,
            &other_scope,
            &foreign,
        ] {
            memories.upsert(r).await.unwrap();
        }

        let mut q = text_query(&profile, vec![scope.clone()], &["ramen"], 2);
        q.embedding = Some(vec![1.0, 0.0, 0.0]);
        let hits = memories.search(&q).await.unwrap();
        assert_eq!(
            hit_ids(&hits),
            id_set(&[&both, &text_only, &vector_only]),
            "two text hits and two vector hits, merged by id"
        );
        let find = |r: &MemoryRecord| hits.iter().find(|h| h.record.id == r.id).unwrap();
        let merged = find(&both);
        assert!(merged.text_score > 0.0);
        assert!(near(merged.vector_score.unwrap(), 1.0));
        let only_text = find(&text_only);
        assert!(only_text.text_score > 0.0);
        assert_eq!(only_text.vector_score, None);
        let only_vector = find(&vector_only);
        assert_eq!(only_vector.text_score, 0.0);
        let cosine = 0.9 / (0.9_f32 * 0.9 + 0.1 * 0.1).sqrt();
        assert!(near(only_vector.vector_score.unwrap(), cosine));

        // Vector only: nearest first, same dimension only, limit applies.
        let mut q = text_query(&profile, vec![scope.clone()], &[], 2);
        q.embedding = Some(vec![1.0, 0.0, 0.0]);
        let mut hits = memories.search(&q).await.unwrap();
        hits.sort_by(|a, b| b.vector_score.partial_cmp(&a.vector_score).unwrap());
        assert_eq!(
            hits.iter().map(|h| h.record.id).collect::<Vec<_>>(),
            [both.id, vector_only.id]
        );
        assert!(hits.iter().all(|h| h.text_score == 0.0));

        q.embedding = Some(vec![1.0, 0.0]);
        let hits = memories.search(&q).await.unwrap();
        assert_eq!(hit_ids(&hits), BTreeSet::from([other_dims.id]));

        q.embedding = Some(vec![1.0, 0.0, 0.0, 0.0]);
        assert!(memories.search(&q).await.unwrap().is_empty());
        q.embedding = Some(vec![1.0, f32::INFINITY]);
        assert!(memories.search(&q).await.is_err());
    }

    pub async fn memory_list_filters(store: &Store) {
        let memories = &store.memories;
        let profile = ProfileId(unique("profile"));
        let other_profile = ProfileId(unique("profile"));
        let t0 = now_micros();
        let alice = PersonId::new();
        let bob = PersonId::new();
        let guild = guild_scope(&unique("g"));
        let mk = |kind, scope: &MemoryScope, subjects: Vec<PersonId>, secs: i64| {
            let mut r = memory(
                &profile,
                kind,
                scope.clone(),
                "x",
                t0 + Duration::seconds(secs),
            );
            r.subjects = subjects;
            r
        };
        let a = mk(MemoryKind::Episode, &guild, vec![alice], 1);
        let b = mk(MemoryKind::Fact, &MemoryScope::Global, vec![alice, bob], 2);
        let c = mk(MemoryKind::Fact, &guild, vec![bob], 3);
        let d = mk(MemoryKind::SelfNote, &MemoryScope::Global, vec![], 4);
        for r in [&a, &b, &c, &d] {
            memories.upsert(r).await.unwrap();
        }
        memories
            .upsert(&memory(
                &other_profile,
                MemoryKind::Fact,
                MemoryScope::Global,
                "x",
                t0,
            ))
            .await
            .unwrap();

        let list = |filter: MemoryFilter| {
            let memories = memories.clone();
            let profile = profile.clone();
            async move { record_ids(&memories.list(&profile, &filter).await.unwrap()) }
        };
        let base = MemoryFilter {
            limit: 100,
            ..MemoryFilter::default()
        };
        assert_eq!(list(base.clone()).await, [d.id, c.id, b.id, a.id]);
        let limited = MemoryFilter {
            limit: 2,
            ..base.clone()
        };
        assert_eq!(list(limited).await, [d.id, c.id]);
        let none = MemoryFilter {
            limit: 0,
            ..base.clone()
        };
        assert!(list(none).await.is_empty());
        let by_subject = MemoryFilter {
            subject: Some(alice),
            ..base.clone()
        };
        assert_eq!(list(by_subject).await, [b.id, a.id]);
        let by_scope = MemoryFilter {
            scope: Some(guild.clone()),
            ..base.clone()
        };
        assert_eq!(list(by_scope).await, [c.id, a.id]);
        let by_kind = MemoryFilter {
            kind: Some(MemoryKind::Fact),
            ..base.clone()
        };
        assert_eq!(list(by_kind).await, [c.id, b.id]);
        let before = MemoryFilter {
            before: Some(c.created_at),
            ..base.clone()
        };
        assert_eq!(list(before).await, [b.id, a.id]);
        let combined = MemoryFilter {
            subject: Some(bob),
            kind: Some(MemoryKind::Fact),
            scope: Some(guild),
            ..base
        };
        assert_eq!(list(combined).await, [c.id]);
    }

    pub async fn memory_touch(store: &Store) {
        let memories = &store.memories;
        let profile = ProfileId(unique("profile"));
        let t0 = now_micros();
        let a = memory(&profile, MemoryKind::Fact, MemoryScope::Global, "a", t0);
        let b = memory(&profile, MemoryKind::Fact, MemoryScope::Global, "b", t0);
        memories.upsert(&a).await.unwrap();
        memories.upsert(&b).await.unwrap();

        let t1 = t0 + Duration::minutes(1);
        let t2 = t0 + Duration::minutes(2);
        memories
            .touch(&[a.id, a.id, Ulid::new()], t1)
            .await
            .unwrap();
        memories.touch(&[a.id], t2).await.unwrap();
        memories.touch(&[], t2).await.unwrap();
        let a2 = memories.get(a.id).await.unwrap().unwrap();
        assert_eq!(a2.access_count, 2);
        assert_eq!(a2.last_accessed, Some(t2));
        let b2 = memories.get(b.id).await.unwrap().unwrap();
        assert_eq!(b2.access_count, 0);
        assert_eq!(b2.last_accessed, None);
    }

    pub async fn memory_due_followups(store: &Store) {
        let memories = &store.memories;
        let profile = ProfileId(unique("profile"));
        let other_profile = ProfileId(unique("profile"));
        let now = now_micros();
        let followup = |profile: &ProfileId, due: Option<DateTime<Utc>>| {
            let mut r = memory(
                profile,
                MemoryKind::Followup,
                MemoryScope::Global,
                "ask",
                now - Duration::days(1),
            );
            r.due = due;
            r
        };
        let later = followup(&profile, Some(now - Duration::hours(1)));
        let earlier = followup(&profile, Some(now - Duration::hours(5)));
        let exactly_now = followup(&profile, Some(now));
        let future = followup(&profile, Some(now + Duration::hours(1)));
        let no_due = followup(&profile, None);
        let mut done = followup(&profile, Some(now - Duration::hours(2)));
        done.done = true;
        let mut superseded = followup(&profile, Some(now - Duration::hours(3)));
        superseded.superseded_by = Some(Ulid::new());
        let mut not_followup = followup(&profile, Some(now - Duration::hours(4)));
        not_followup.kind = MemoryKind::Fact;
        let foreign = followup(&other_profile, Some(now - Duration::hours(1)));
        for r in [
            &later,
            &earlier,
            &exactly_now,
            &future,
            &no_due,
            &done,
            &superseded,
            &not_followup,
            &foreign,
        ] {
            memories.upsert(r).await.unwrap();
        }

        let due = memories.due_followups(&profile, now).await.unwrap();
        assert_eq!(record_ids(&due), [earlier.id, later.id, exactly_now.id]);
        let due = memories
            .due_followups(&profile, now + Duration::hours(2))
            .await
            .unwrap();
        assert_eq!(
            record_ids(&due),
            [earlier.id, later.id, exactly_now.id, future.id]
        );
        let due = memories
            .due_followups(&profile, now - Duration::days(2))
            .await
            .unwrap();
        assert!(due.is_empty());
    }

    pub async fn memory_prune(store: &Store) {
        let memories = &store.memories;
        let profile = ProfileId(unique("profile"));
        let other_profile = ProfileId(unique("profile"));
        let now = now_micros();
        let old = now - Duration::days(90);
        let policy = PrunePolicy {
            created_before: now - Duration::days(30),
            max_importance: 0.25,
            not_accessed_since: now - Duration::days(14),
        };
        let mk = |profile: &ProfileId, kind, created: DateTime<Utc>, importance: f32| {
            let mut r = memory(profile, kind, MemoryScope::Global, "x", created);
            r.importance = importance;
            r
        };
        let forgettable = mk(&profile, MemoryKind::Episode, old, 0.125);
        let at_limit = mk(&profile, MemoryKind::Episode, old, 0.25);
        let mut stale_access = mk(&profile, MemoryKind::Episode, old, 0.0);
        stale_access.last_accessed = Some(now - Duration::days(60));
        let important = mk(&profile, MemoryKind::Episode, old, 0.5);
        let mut recently_used = mk(&profile, MemoryKind::Episode, old, 0.0);
        recently_used.last_accessed = Some(now - Duration::days(1));
        let recent = mk(&profile, MemoryKind::Episode, now - Duration::days(1), 0.0);
        let fact = mk(&profile, MemoryKind::Fact, old, 0.0);
        let note = mk(&profile, MemoryKind::SelfNote, old, 0.0);
        let followup = mk(&profile, MemoryKind::Followup, old, 0.0);
        let foreign = mk(&other_profile, MemoryKind::Episode, old, 0.0);
        for r in [
            &forgettable,
            &at_limit,
            &stale_access,
            &important,
            &recently_used,
            &recent,
            &fact,
            &note,
            &followup,
            &foreign,
        ] {
            memories.upsert(r).await.unwrap();
        }

        assert_eq!(memories.prune(&profile, &policy).await.unwrap(), 3);
        assert_eq!(memories.prune(&profile, &policy).await.unwrap(), 0);
        for gone in [&forgettable, &at_limit, &stale_access] {
            assert_eq!(memories.get(gone.id).await.unwrap(), None);
        }
        for kept in [
            &important,
            &recently_used,
            &recent,
            &fact,
            &note,
            &followup,
            &foreign,
        ] {
            assert!(memories.get(kept.id).await.unwrap().is_some());
        }
    }

    pub async fn memory_delete_by_subject(store: &Store) {
        let memories = &store.memories;
        let profile = ProfileId(unique("profile"));
        let other_profile = ProfileId(unique("profile"));
        let t0 = now_micros();
        let alice = PersonId::new();
        let bob = PersonId::new();
        let mk = |profile: &ProfileId, scope: MemoryScope, subjects: Vec<PersonId>| {
            let mut r = memory(profile, MemoryKind::Fact, scope, "x", t0);
            r.subjects = subjects;
            r
        };
        let about_alice = mk(&profile, MemoryScope::Global, vec![alice]);
        let about_both = mk(&profile, guild_scope(&unique("g")), vec![bob, alice]);
        let alice_scope = mk(&profile, MemoryScope::Person { person: alice }, vec![]);
        let about_bob = mk(&profile, MemoryScope::Global, vec![bob]);
        let bob_scope = mk(&profile, MemoryScope::Person { person: bob }, vec![bob]);
        let unrelated = mk(&profile, MemoryScope::Global, vec![]);
        let foreign = mk(&other_profile, MemoryScope::Global, vec![alice]);
        for r in [
            &about_alice,
            &about_both,
            &alice_scope,
            &about_bob,
            &bob_scope,
            &unrelated,
            &foreign,
        ] {
            memories.upsert(r).await.unwrap();
        }

        assert_eq!(
            memories.delete_by_subject(&profile, alice).await.unwrap(),
            3
        );
        assert_eq!(
            memories.delete_by_subject(&profile, alice).await.unwrap(),
            0
        );
        for gone in [&about_alice, &about_both, &alice_scope] {
            assert_eq!(memories.get(gone.id).await.unwrap(), None);
        }
        for kept in [&about_bob, &bob_scope, &unrelated, &foreign] {
            assert!(memories.get(kept.id).await.unwrap().is_some());
        }
        assert_eq!(
            memories
                .delete_by_subject(&other_profile, alice)
                .await
                .unwrap(),
            1
        );
    }
}

// ---------------------------------------------------------------------------
// Relationships and identity
// ---------------------------------------------------------------------------

fn relationship(profile: &ProfileId, person: PersonId) -> Relationship {
    Relationship {
        profile: profile.clone(),
        person,
        affinity: 12.5,
        trust: 40.0,
        familiarity: 7.25,
        tags: vec!["friend".to_owned(), "regular".to_owned()],
        notes: "愛開玩笑".to_owned(),
        call_name: Some("歐文".to_owned()),
        interactions: 9,
        last_interaction: Some(now_micros()),
        updated_at: now_micros(),
    }
}

fn delta(at: DateTime<Utc>, affinity: f32, reason: &str) -> RelationshipDelta {
    RelationshipDelta {
        at,
        affinity,
        trust: 0.5,
        familiarity: 0.25,
        reason: reason.to_owned(),
    }
}

mod social_cases {
    use super::*;

    pub async fn relationships(store: &Store) {
        let rel = &store.relationships;
        let profile = ProfileId(unique("profile"));
        let other_profile = ProfileId(unique("profile"));
        let alice = PersonId::new();
        let bob = PersonId::new();
        assert_eq!(rel.get(&profile, alice).await.unwrap(), None);
        assert!(rel.list(&profile).await.unwrap().is_empty());

        let mut a = relationship(&profile, alice);
        rel.upsert(&a).await.unwrap();
        assert_eq!(rel.get(&profile, alice).await.unwrap(), Some(a.clone()));

        // Replaced as a whole, including cleared options.
        a.affinity = -30.0;
        a.tags = Vec::new();
        a.call_name = None;
        a.last_interaction = None;
        a.interactions = 10;
        rel.upsert(&a).await.unwrap();
        assert_eq!(rel.get(&profile, alice).await.unwrap(), Some(a.clone()));

        let b = relationship(&profile, bob);
        rel.upsert(&b).await.unwrap();
        rel.upsert(&relationship(&other_profile, alice))
            .await
            .unwrap();
        let mut expected = vec![a.clone(), b.clone()];
        expected.sort_by_key(|r| r.person);
        assert_eq!(rel.list(&profile).await.unwrap(), expected);
        assert_eq!(rel.list(&other_profile).await.unwrap().len(), 1);

        assert!(rel.delete(&profile, alice).await.unwrap());
        assert!(!rel.delete(&profile, alice).await.unwrap());
        assert_eq!(rel.get(&profile, alice).await.unwrap(), None);
        assert!(rel.get(&other_profile, alice).await.unwrap().is_some());
        assert_eq!(rel.list(&profile).await.unwrap(), vec![b]);
    }

    pub async fn relationship_deltas(store: &Store) {
        let rel = &store.relationships;
        let profile = ProfileId(unique("profile"));
        let alice = PersonId::new();
        let bob = PersonId::new();
        let t0 = now_micros();

        // Recorded out of order; equal timestamps keep recording order.
        for (secs, reason) in [(3, "c"), (1, "a"), (2, "b1"), (2, "b2"), (5, "e")] {
            rel.record_delta(
                &profile,
                alice,
                &delta(t0 + Duration::seconds(secs), 1.0, reason),
            )
            .await
            .unwrap();
        }
        rel.record_delta(&profile, bob, &delta(t0, 9.0, "bob"))
            .await
            .unwrap();
        rel.record_delta(
            &ProfileId(unique("profile")),
            alice,
            &delta(t0, 9.0, "other profile"),
        )
        .await
        .unwrap();

        let reasons_since = |secs: i64| {
            let rel = rel.clone();
            let profile = profile.clone();
            async move {
                rel.deltas_since(&profile, alice, t0 + Duration::seconds(secs))
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|d| d.reason)
                    .collect::<Vec<_>>()
            }
        };
        assert_eq!(reasons_since(-10).await, ["a", "b1", "b2", "c", "e"]);
        // Inclusive start.
        assert_eq!(reasons_since(2).await, ["b1", "b2", "c", "e"]);
        assert_eq!(reasons_since(4).await, ["e"]);
        assert!(reasons_since(6).await.is_empty());

        let got = rel
            .deltas_since(&profile, bob, t0 - Duration::seconds(1))
            .await
            .unwrap();
        assert_eq!(got, vec![delta(t0, 9.0, "bob")]);

        // Deleting a relationship drops its history.
        rel.upsert(&relationship(&profile, alice)).await.unwrap();
        assert!(rel.delete(&profile, alice).await.unwrap());
        assert!(reasons_since(-10).await.is_empty());
        assert_eq!(
            rel.deltas_since(&profile, bob, t0 - Duration::seconds(1))
                .await
                .unwrap()
                .len(),
            1
        );
    }

    pub async fn identity_link_and_merge(store: &Store) {
        let people = &store.people;
        let identity = &store.identity;
        let a1 = account(&unique("a1"));
        let a2 = account(&unique("a2"));
        let unseen = account(&unique("unseen"));
        let p1 = people.upsert_account(&a1, "One").await.unwrap();
        let p2 = people.upsert_account(&a2, "Two").await.unwrap();

        // An account that was never seen can be linked.
        identity.link_account(&unseen, p2).await.unwrap();
        let accounts = identity.accounts_of(p2).await.unwrap();
        assert_eq!(
            accounts.iter().map(|a| &a.account).collect::<Vec<_>>(),
            [&a2, &unseen]
        );
        assert_eq!(
            people.person_by_account(&unseen).await.unwrap().unwrap().id,
            p2
        );

        // A later sighting keeps the link and sets the name.
        assert_eq!(people.upsert_account(&unseen, "Seen").await.unwrap(), p2);
        let accounts = identity.accounts_of(p2).await.unwrap();
        assert_eq!(accounts[1].display_name, "Seen");

        // Moving an account.
        identity.link_account(&unseen, p1).await.unwrap();
        identity.link_account(&unseen, p1).await.unwrap();
        assert_eq!(identity.accounts_of(p1).await.unwrap().len(), 2);
        assert_eq!(identity.accounts_of(p2).await.unwrap().len(), 1);

        identity.set_person_name(p1, "Renamed").await.unwrap();
        let person = people.person_by_account(&a1).await.unwrap().unwrap();
        assert_eq!(person.display_name, "Renamed");

        // Merge: everything of p2 moves to p1 and p2 is gone.
        identity.merge_people(p1, p2).await.unwrap();
        let person = people.person_by_account(&a2).await.unwrap().unwrap();
        assert_eq!(person.id, p1);
        assert_eq!(person.display_name, "Renamed");
        assert_eq!(person.accounts.len(), 3);
        assert!(identity.accounts_of(p2).await.unwrap().is_empty());
        assert!(identity.merge_people(p1, p2).await.is_err());
        assert!(identity.merge_people(p2, p1).await.is_err());
        identity.merge_people(p1, p1).await.unwrap();
        assert_eq!(identity.accounts_of(p1).await.unwrap().len(), 3);

        // Unknown people are rejected.
        let ghost = PersonId::new();
        assert!(
            identity
                .link_account(&account(&unique("x")), ghost)
                .await
                .is_err()
        );
        assert!(identity.set_person_name(ghost, "Nobody").await.is_err());
        assert!(identity.accounts_of(ghost).await.unwrap().is_empty());
    }

    pub async fn identity_link_codes(store: &Store) {
        let identity = &store.identity;
        let issuer = account(&unique("issuer"));
        let other = account(&unique("other"));
        let now = now_micros();

        let code = unique("code");
        identity
            .create_link_code(&code, &issuer, now + Duration::minutes(10))
            .await
            .unwrap();
        assert_eq!(
            identity.consume_link_code(&code, now).await.unwrap(),
            Some(issuer.clone())
        );
        // One use only.
        assert_eq!(identity.consume_link_code(&code, now).await.unwrap(), None);
        assert_eq!(
            identity
                .consume_link_code(&unique("nope"), now)
                .await
                .unwrap(),
            None
        );

        // Expired, including exactly at the expiry instant.
        let expired = unique("code");
        identity
            .create_link_code(&expired, &issuer, now + Duration::minutes(1))
            .await
            .unwrap();
        assert_eq!(
            identity
                .consume_link_code(&expired, now + Duration::minutes(2))
                .await
                .unwrap(),
            None
        );
        // It is gone even for a valid time.
        assert_eq!(
            identity.consume_link_code(&expired, now).await.unwrap(),
            None
        );
        let instant = unique("code");
        identity
            .create_link_code(&instant, &issuer, now)
            .await
            .unwrap();
        assert_eq!(
            identity.consume_link_code(&instant, now).await.unwrap(),
            None
        );
        let almost = unique("code");
        identity
            .create_link_code(&almost, &issuer, now + Duration::microseconds(1))
            .await
            .unwrap();
        assert_eq!(
            identity.consume_link_code(&almost, now).await.unwrap(),
            Some(issuer.clone())
        );

        // Issuing the same code again replaces it.
        let reissued = unique("code");
        for who in [&issuer, &other] {
            identity
                .create_link_code(&reissued, who, now + Duration::minutes(5))
                .await
                .unwrap();
        }
        assert_eq!(
            identity.consume_link_code(&reissued, now).await.unwrap(),
            Some(other)
        );
    }
}

// ---------------------------------------------------------------------------
// Authorization and audit
// ---------------------------------------------------------------------------

fn role(name: &str, rank: i32, builtin: bool) -> RoleDefinition {
    RoleDefinition {
        name: name.to_owned(),
        rank,
        grants: vec!["queue.*".to_owned(), "chat.send".to_owned()],
        denies: vec!["voice.join".to_owned()],
        builtin,
    }
}

fn assignment(
    who: &AccountRef,
    role: &str,
    scope: &AuthScope,
    by: &str,
    at: DateTime<Utc>,
) -> RoleAssignment {
    RoleAssignment {
        account: who.clone(),
        role: role.to_owned(),
        scope: scope.clone(),
        granted_by: by.to_owned(),
        at,
    }
}

fn guild_auth(guild: &str) -> AuthScope {
    AuthScope::Guild {
        platform: PlatformId::new("discord"),
        guild: guild.to_owned(),
    }
}

mod auth_cases {
    use super::*;

    pub async fn auth_roles(store: &Store) {
        let auth = &store.auth;
        let name = unique("role");
        let mut r = role(&name, 50, false);
        let find = |roles: Vec<RoleDefinition>, name: &str| {
            roles
                .into_iter()
                .filter(|r| r.name == name)
                .collect::<Vec<_>>()
        };
        assert!(find(auth.roles().await.unwrap(), &name).is_empty());

        auth.upsert_role(&r).await.unwrap();
        assert_eq!(find(auth.roles().await.unwrap(), &name), [r.clone()]);
        r.rank = 70;
        r.grants = vec!["*".to_owned()];
        r.denies = Vec::new();
        auth.upsert_role(&r).await.unwrap();
        assert_eq!(find(auth.roles().await.unwrap(), &name), [r.clone()]);

        // Highest rank first, then by name.
        let prefix = unique("ranked");
        let low_b = role(&format!("{prefix}-b"), 10, false);
        let high = role(&format!("{prefix}-z"), 90, false);
        let low_a = role(&format!("{prefix}-a"), 10, false);
        for x in [&low_b, &high, &low_a] {
            auth.upsert_role(x).await.unwrap();
        }
        let ranked: Vec<String> = auth
            .roles()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.name.starts_with(&prefix))
            .map(|r| r.name)
            .collect();
        assert_eq!(ranked, [high.name, low_a.name, low_b.name]);

        // Built-in roles can be edited, not deleted.
        let builtin = role(&unique("builtin"), 100, true);
        auth.upsert_role(&builtin).await.unwrap();
        assert!(auth.delete_role(&builtin.name).await.is_err());
        assert_eq!(
            find(auth.roles().await.unwrap(), &builtin.name),
            vec![builtin.clone()]
        );
        let edited = RoleDefinition {
            grants: vec!["admin.*".to_owned()],
            ..builtin.clone()
        };
        auth.upsert_role(&edited).await.unwrap();
        assert_eq!(find(auth.roles().await.unwrap(), &builtin.name), [edited]);

        // Deleting a role also removes what refers to it.
        let who = account(&unique("who"));
        let scope = guild_auth(&unique("g"));
        let platform = PlatformId::new("discord");
        let guild = unique("g");
        auth.assign(&assignment(&who, &name, &scope, "test", now_micros()))
            .await
            .unwrap();
        auth.set_mapping(&RoleMapping {
            platform: platform.clone(),
            guild: guild.clone(),
            platform_role: "42".to_owned(),
            role: name.clone(),
        })
        .await
        .unwrap();
        auth.set_override(&NodeOverride {
            scope: scope.clone(),
            role: name.clone(),
            node: "voice.join".to_owned(),
            allow: true,
        })
        .await
        .unwrap();
        assert!(auth.delete_role(&name).await.unwrap());
        assert!(!auth.delete_role(&name).await.unwrap());
        assert!(find(auth.roles().await.unwrap(), &name).is_empty());
        assert!(auth.assignments_for(&who).await.unwrap().is_empty());
        assert!(auth.mappings(&platform, &guild).await.unwrap().is_empty());
        assert!(
            auth.overrides()
                .await
                .unwrap()
                .iter()
                .all(|o| o.role != name)
        );
    }

    pub async fn auth_assignments(store: &Store) {
        let auth = &store.auth;
        let a = account(&unique("a"));
        let b = account(&unique("b"));
        let role_name = unique("role");
        let global = AuthScope::Global;
        let guild = guild_auth(&unique("g"));
        let chan = AuthScope::Channel {
            context: channel(Some("g"), &unique("c"), ContextKind::Channel),
        };
        let t0 = now_micros();
        assert!(auth.assignments_for(&a).await.unwrap().is_empty());

        let a_global = assignment(&a, &role_name, &global, "config", t0);
        let a_guild = assignment(
            &a,
            &role_name,
            &guild,
            "discord:1",
            t0 + Duration::seconds(1),
        );
        let b_global = assignment(
            &b,
            &role_name,
            &global,
            "discord:1",
            t0 + Duration::seconds(2),
        );
        for x in [&b_global, &a_guild, &a_global] {
            auth.assign(x).await.unwrap();
        }
        // Oldest first.
        assert_eq!(
            auth.assignments_for(&a).await.unwrap(),
            [a_global.clone(), a_guild.clone()]
        );
        let mine: Vec<_> = auth
            .all_assignments()
            .await
            .unwrap()
            .into_iter()
            .filter(|x| x.role == role_name)
            .collect();
        assert_eq!(mine, [a_global.clone(), a_guild.clone(), b_global.clone()]);

        // Same (account, role, scope): replaced.
        let renewed = assignment(
            &a,
            &role_name,
            &global,
            "discord:2",
            t0 + Duration::seconds(3),
        );
        auth.assign(&renewed).await.unwrap();
        assert_eq!(
            auth.assignments_for(&a).await.unwrap(),
            [a_guild.clone(), renewed.clone()]
        );

        assert!(!auth.revoke(&a, &role_name, &chan).await.unwrap());
        assert!(!auth.revoke(&a, "other-role", &global).await.unwrap());
        assert!(auth.revoke(&a, &role_name, &global).await.unwrap());
        assert!(!auth.revoke(&a, &role_name, &global).await.unwrap());
        assert_eq!(auth.assignments_for(&a).await.unwrap(), [a_guild]);
        assert_eq!(auth.assignments_for(&b).await.unwrap(), [b_global]);
    }

    pub async fn auth_mappings_and_overrides(store: &Store) {
        let auth = &store.auth;
        let discord = PlatformId::new("discord");
        let g1 = unique("g");
        let g2 = unique("g");
        let mapping = |guild: &str, platform_role: &str, role: &str| RoleMapping {
            platform: discord.clone(),
            guild: guild.to_owned(),
            platform_role: platform_role.to_owned(),
            role: role.to_owned(),
        };
        assert!(auth.mappings(&discord, &g1).await.unwrap().is_empty());

        auth.set_mapping(&mapping(&g1, "222", "moderator"))
            .await
            .unwrap();
        auth.set_mapping(&mapping(&g1, "111", "user"))
            .await
            .unwrap();
        auth.set_mapping(&mapping(&g1, "111", "trusted"))
            .await
            .unwrap();
        auth.set_mapping(&mapping(&g2, "111", "admin"))
            .await
            .unwrap();
        assert_eq!(
            auth.mappings(&discord, &g1).await.unwrap(),
            [
                mapping(&g1, "111", "trusted"),
                mapping(&g1, "222", "moderator")
            ]
        );
        assert_eq!(
            auth.mappings(&discord, &g2).await.unwrap(),
            [mapping(&g2, "111", "admin")]
        );
        assert!(
            auth.mappings(&PlatformId::new("twitch"), &g1)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(auth.remove_mapping(&discord, &g1, "111").await.unwrap());
        assert!(!auth.remove_mapping(&discord, &g1, "111").await.unwrap());
        assert_eq!(auth.mappings(&discord, &g1).await.unwrap().len(), 1);
        assert_eq!(auth.mappings(&discord, &g2).await.unwrap().len(), 1);

        let role_name = unique("role");
        let guild = guild_auth(&g1);
        let chan = AuthScope::Channel {
            context: channel(Some("g"), &unique("c"), ContextKind::Voice),
        };
        let over = |scope: &AuthScope, node: &str, allow: bool| NodeOverride {
            scope: scope.clone(),
            role: role_name.clone(),
            node: node.to_owned(),
            allow,
        };
        let mine = |all: Vec<NodeOverride>| -> Vec<NodeOverride> {
            all.into_iter().filter(|o| o.role == role_name).collect()
        };
        assert!(mine(auth.overrides().await.unwrap()).is_empty());

        auth.set_override(&over(&guild, "voice.join", true))
            .await
            .unwrap();
        auth.set_override(&over(&chan, "voice.join", true))
            .await
            .unwrap();
        auth.set_override(&over(&guild, "voice.join", false))
            .await
            .unwrap();
        auth.set_override(&over(&guild, "queue.add", true))
            .await
            .unwrap();
        let got = mine(auth.overrides().await.unwrap());
        assert_eq!(got.len(), 3);
        for expected in [
            over(&guild, "voice.join", false),
            over(&chan, "voice.join", true),
            over(&guild, "queue.add", true),
        ] {
            assert!(got.contains(&expected), "missing {expected:?}");
        }

        assert!(
            !auth
                .remove_override(&guild, &role_name, "missing")
                .await
                .unwrap()
        );
        assert!(
            auth.remove_override(&guild, &role_name, "voice.join")
                .await
                .unwrap()
        );
        assert!(
            !auth
                .remove_override(&guild, &role_name, "voice.join")
                .await
                .unwrap()
        );
        assert_eq!(mine(auth.overrides().await.unwrap()).len(), 2);
    }

    pub async fn audit_log(store: &Store) {
        let audit = &store.audit;
        let actor = unique("actor");
        let other_actor = unique("actor");
        let t0 = now_micros();
        let entry = |actor: &str, action: &str, secs: i64| AuditEntry {
            id: Ulid::new(),
            at: t0 + Duration::seconds(secs),
            actor: actor.to_owned(),
            action: action.to_owned(),
            target: "discord:123".to_owned(),
            detail: json!({"reason": "測試", "n": [1, 2], "nested": {"ok": null}}),
            ok: secs % 2 == 0,
        };
        let recent = |limit: usize, actor: Option<String>| {
            let audit = audit.clone();
            async move {
                audit
                    .recent(limit, actor.as_deref())
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|e| e.action)
                    .collect::<Vec<_>>()
            }
        };
        assert!(recent(10, Some(actor.clone())).await.is_empty());

        // Appended out of order.
        let first = entry(&actor, "first", 1);
        for e in [
            entry(&actor, "third", 3),
            first.clone(),
            entry(&actor, "fourth", 4),
            entry(&actor, "second", 2),
            entry(&other_actor, "elsewhere", 2),
        ] {
            audit.append(&e).await.unwrap();
        }
        assert_eq!(
            recent(10, Some(actor.clone())).await,
            ["fourth", "third", "second", "first"]
        );
        assert_eq!(recent(2, Some(actor.clone())).await, ["fourth", "third"]);
        assert!(recent(0, Some(actor.clone())).await.is_empty());
        assert_eq!(recent(10, Some(other_actor.clone())).await, ["elsewhere"]);
        assert!(recent(10, Some(unique("nobody"))).await.is_empty());

        // Without an actor filter the same relative order holds.
        let all = recent(100_000, None).await;
        let ours: Vec<_> = all
            .into_iter()
            .filter(|a| ["first", "second", "third", "fourth"].contains(&a.as_str()))
            .collect();
        assert!(ours.len() >= 4);

        let got = audit.recent(10, Some(&actor)).await.unwrap();
        let last = got.last().unwrap();
        assert_eq!(last, &first);
        assert!(
            audit.append(&first).await.is_err(),
            "duplicate id must fail"
        );
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
    ($($module:ident: [$($case:ident),* $(,)?]),* $(,)?) => {
        mod memory {
            $($(
                #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
                async fn $case() {
                    super::$module::$case(&miyoria_store::Store::memory()).await;
                }
            )*)*
        }

        mod postgres {
            $($(
                #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
                async fn $case() {
                    if let Some(store) = super::postgres().await {
                        super::$module::$case(&store).await;
                    }
                }
            )*)*
        }
    };
}

suite!(
    cases: [
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
    ],
    memory_cases: [
        memory_round_trip,
        memory_search_scopes,
        memory_search_superseded,
        memory_search_vector_and_text,
        memory_list_filters,
        memory_touch,
        memory_due_followups,
        memory_prune,
        memory_delete_by_subject,
    ],
    social_cases: [
        relationships,
        relationship_deltas,
        identity_link_and_merge,
        identity_link_codes,
    ],
    auth_cases: [
        auth_roles,
        auth_assignments,
        auth_mappings_and_overrides,
        audit_log,
    ],
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
