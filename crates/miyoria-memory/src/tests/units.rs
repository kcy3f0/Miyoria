//! Pure functions: tokenizer, dates, parsing, scoring, scopes, triggers.

use chrono::Duration;
use miyoria_store::{MemoryKind, MemoryScope};
use miyoria_types::{Participant, PersonId, PromptRequest, TurnId};

use super::*;
use crate::config::{GuildScope, MemoryConfig, Weights};
use crate::extract::{SubjectName, parse_extraction};
use crate::module::ActivityTracker;
use crate::scope::{request_scopes, scope_for_new, visible_scopes};
use crate::score::{Signals, relative_date, token_overlap};
use crate::tokenize::{text_similarity, tokenize};

#[test]
fn tokenizes_chinese_with_jieba_and_drops_stop_words() {
    let tokens = tokenize("我超喜歡吃拉麵,尤其是豚骨拉麵!");
    assert!(!tokens.is_empty());
    for stop in ["我", "是", ",", "!"] {
        assert!(!tokens.contains(&stop.to_owned()), "{tokens:?}");
    }
    // Queries are segmented the same way, so they match stored tokens.
    let query = tokenize("拉麵");
    assert!(!query.is_empty());
    assert!(
        query.iter().all(|t| tokens.contains(t)),
        "{query:?} vs {tokens:?}"
    );
    // Traditional and simplified text produce the same tokens.
    assert_eq!(tokenize("Owen 喜歡拉麵"), tokenize("Owen 喜欢拉面"));
    assert!(tokenize("Owen 下週三要看牙醫").contains(&tokenize("牙醫")[0]));
}

#[test]
fn tokenizes_japanese_and_english() {
    let ja = tokenize("ラーメンが大好きです");
    assert!(ja.contains(&"ラーメン".to_owned()), "{ja:?}");
    assert!(!ja.contains(&"が".to_owned()) && !ja.contains(&"です".to_owned()));

    assert_eq!(
        tokenize("Owen LOVES the Ramen!"),
        ["owen", "loves", "ramen"]
    );
    assert_eq!(tokenize("Ｏｗｅｎ　ｏｗｅｎ"), ["owen"]);
    assert_eq!(tokenize("I'm a b c"), Vec::<String>::new());
    assert_eq!(tokenize("Minecraft 2026"), ["minecraft", "2026"]);
}

#[test]
fn text_similarity_ignores_case_and_punctuation() {
    assert_eq!(text_similarity("Owen 喜歡拉麵。", "owen喜歡拉麵!"), 1.0);
    assert!(text_similarity("Owen 喜歡拉麵", "Amy 討厭下雨天") < 0.3);
    assert!(text_similarity("Owen 下週三要考期末考", "Owen 下週三要考期末考試") > 0.85);
    assert_eq!(text_similarity("", ""), 0.0);
}

#[test]
fn relative_dates_in_chinese() {
    let now = t0();
    let cases = [
        (Duration::minutes(10), "剛剛"),
        (Duration::hours(3), "三小時前"),
        (Duration::hours(30), "昨天"),
        (Duration::days(2), "前天"),
        (Duration::days(3), "三天前"),
        (Duration::days(14), "兩週前"),
        (Duration::days(60), "兩個月前"),
        (Duration::days(400), "一年前"),
        (Duration::hours(15), "十五小時前"),
        (Duration::minutes(-5), "剛剛"),
    ];
    for (ago, want) in cases {
        assert_eq!(relative_date(now - ago, now), want, "{ago:?}");
    }
}

#[test]
fn parses_summarizer_json_leniently() {
    let text = r#"好的,以下是結果:
```json
{"episode": {"summary": "我們聊了拉麵", "importance": "7", "emotion": "開心"},
 "facts": [
   {"subject_name": "Owen", "statement": "Owen 喜歡拉麵", "importance": 0.8, "confidence": 90, "global": "false"},
   {"subject_name": "self", "statement": "我不太會煮飯", "importance": 0.4, "confidence": 1, "global": false},
   123,
   {"subject_name": "Amy"}
 ],
 "self_notes": ["我答應 Owen 下次一起吃拉麵", {"note": "我覺得豚骨最好吃", "importance": 0.5}, {}],
 "followups": [{"subject_name": "Owen", "about": "問 Owen 拉麵店好不好吃", "due_in_hours": "48"}]
}
```"#;
    let x = parse_extraction(text).unwrap();
    let ep = x.episode.unwrap();
    assert_eq!(ep.summary, "我們聊了拉麵");
    assert!((ep.importance - 0.7).abs() < 1e-6);
    assert_eq!(ep.emotion.as_deref(), Some("開心"));
    assert_eq!(x.facts.len(), 2);
    assert_eq!(x.facts[0].subject, SubjectName::Named("Owen".into()));
    assert!((x.facts[0].confidence - 0.9).abs() < 1e-6);
    assert!(!x.facts[0].global);
    assert_eq!(x.facts[1].subject, SubjectName::Myself);
    assert_eq!(x.self_notes.len(), 2);
    assert_eq!(x.followups[0].due_in_hours, 48.0);
    assert_eq!(x.skipped, 3);

    assert!(parse_extraction("我不知道").is_err());
    assert!(parse_extraction("{oops").is_err());
    assert!(parse_extraction("[1, 2]").is_err());
    let empty = parse_extraction(r#"{"episode": null, "facts": "nope"}"#).unwrap();
    assert!(empty.episode.is_none() && empty.facts.is_empty());
}

#[test]
fn weighted_score() {
    let w = Weights {
        vector: 1.0,
        text: 2.0,
        recency: 3.0,
        importance: 4.0,
        subject: 5.0,
    };
    let s = Signals {
        vector: 0.5,
        text: 0.5,
        recency: 0.5,
        importance: 0.5,
        subject: 1.0,
    };
    assert!((s.score(&w) - (0.5 + 1.0 + 1.5 + 2.0 + 5.0)).abs() < 1e-6);
    assert_eq!(token_overlap(&["a".into(), "b".into()], "b c"), 0.5);
    assert_eq!(token_overlap(&[], "b c"), 0.0);
}

fn request(context: ContextKey, people: &[(&AccountRef, Option<PersonId>)]) -> PromptRequest {
    PromptRequest {
        profile: profile(),
        turn: TurnId::new(),
        context,
        participants: people
            .iter()
            .map(|(a, p)| Participant {
                account: (*a).clone(),
                display_name: a.id.clone(),
                person: *p,
            })
            .collect(),
        speakers: people.iter().map(|(a, _)| (*a).clone()).collect(),
        query: String::new(),
        recent: Vec::new(),
        voice: false,
        now: t0(),
    }
}

#[test]
fn visible_scopes_per_context() {
    let owen = acct("2");
    let owen_p = PersonId::new();
    let guild = guild_ctx("g1", "c1");
    let scopes = request_scopes(&request(guild.clone(), &[(&owen, Some(owen_p))]));
    assert!(scopes.contains(&MemoryScope::Global));
    assert!(scopes.contains(&MemoryScope::Guild {
        platform: PlatformId::new("discord"),
        guild: "g1".into()
    }));
    assert!(scopes.contains(&MemoryScope::Channel {
        context: guild.clone()
    }));
    assert!(scopes.contains(&MemoryScope::Person { person: owen_p }));
    assert!(
        !scopes.iter().any(|s| matches!(s, MemoryScope::Dm { .. })),
        "no DM scope in a guild"
    );
    // Another guild's scope or another channel is not visible.
    assert!(!scopes.contains(&MemoryScope::Guild {
        platform: PlatformId::new("discord"),
        guild: "g2".into()
    }));
    assert!(!scopes.contains(&MemoryScope::Channel {
        context: guild_ctx("g1", "c2")
    }));

    let dm = dm_ctx("d1");
    let scopes = request_scopes(&request(dm.clone(), &[(&owen, None)]));
    assert!(scopes.contains(&MemoryScope::Dm {
        account: owen.clone()
    }));
    assert!(!scopes.contains(&MemoryScope::Dm { account: acct("3") }));
    assert_eq!(
        visible_scopes(&dm, [&owen], None).len(),
        3,
        "global, channel, dm"
    );
}

#[test]
fn default_scopes_for_new_memories() {
    let cfg = MemoryConfig::default();
    let owen = acct("2");
    let p = PersonId::new();
    let guild = guild_ctx("g1", "c1");
    let dm = dm_ctx("d1");
    let g = MemoryScope::Guild {
        platform: PlatformId::new("discord"),
        guild: "g1".into(),
    };
    let dm_scope = MemoryScope::Dm {
        account: owen.clone(),
    };

    assert_eq!(
        scope_for_new(&cfg, &guild, None, MemoryKind::Episode, None),
        g
    );
    assert_eq!(scope_for_new(&cfg, &guild, None, MemoryKind::Fact, None), g);
    assert_eq!(
        scope_for_new(&cfg, &guild, None, MemoryKind::Fact, Some(p)),
        MemoryScope::Person { person: p }
    );
    assert_eq!(
        scope_for_new(&cfg, &guild, None, MemoryKind::SelfNote, None),
        MemoryScope::Global
    );
    for kind in [
        MemoryKind::Episode,
        MemoryKind::Fact,
        MemoryKind::SelfNote,
        MemoryKind::Followup,
    ] {
        // Global facts and self notes from a DM stay in the DM.
        assert_eq!(
            scope_for_new(&cfg, &dm, Some(&owen), kind, Some(p)),
            dm_scope
        );
    }
    assert_eq!(
        scope_for_new(&cfg, &dm, None, MemoryKind::Fact, None),
        MemoryScope::Channel {
            context: dm.clone()
        }
    );

    let open = MemoryConfig {
        allow_global_from_dm: true,
        guild_scope: GuildScope::Channel,
        ..MemoryConfig::default()
    };
    assert_eq!(
        scope_for_new(&open, &dm, Some(&owen), MemoryKind::Fact, Some(p)),
        MemoryScope::Person { person: p }
    );
    assert_eq!(
        scope_for_new(&open, &guild, None, MemoryKind::Episode, None),
        MemoryScope::Channel { context: guild }
    );
}

#[test]
fn activity_tracker_triggers_on_idle_or_count() {
    let cfg = MemoryConfig {
        consolidate_idle_secs: 300,
        consolidate_every_messages: 3,
        ..MemoryConfig::default()
    };
    let a = guild_ctx("g", "a");
    let b = guild_ctx("g", "b");
    let now = t0();
    let mut t = ActivityTracker::default();
    t.message(a.clone(), now);
    t.message(b.clone(), now);
    assert!(t.due(now + Duration::seconds(10), &cfg).is_empty());
    t.message(a.clone(), now);
    t.message(a.clone(), now);
    assert_eq!(t.due(now + Duration::seconds(10), &cfg), vec![a.clone()]);
    let mut due = t.due(now + Duration::seconds(301), &cfg);
    due.sort_by_key(ToString::to_string);
    assert_eq!(due, vec![a.clone(), b.clone()]);

    t.failed(&a, now + Duration::seconds(400));
    assert_eq!(t.due(now + Duration::seconds(301), &cfg), vec![b.clone()]);
    t.done(&b);
    assert_eq!(t.pending(&b), 0);
    assert_eq!(t.due(now + Duration::seconds(401), &cfg), vec![a.clone()]);

    t.maybe_pending(b.clone());
    assert_eq!(t.due(now, &cfg), vec![b]);
}
