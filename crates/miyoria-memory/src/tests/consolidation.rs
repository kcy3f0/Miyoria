//! Consolidation with a scripted summarizer, dedupe and forgetting.

use miyoria_store::{MemoryFilter, MemoryKind, MemoryScope};
use miyoria_types::{FollowupSource, PromptRequest, TurnId};

use super::*;
use crate::config::MemoryConfig;
use crate::contributor::{PROMPT_KINDS, SECTION_TITLE};
use crate::engine::{Stored, WATERMARK_PREFIX};
use crate::scope::{request_scopes, visible_scopes};

const GUILD_JSON: &str = r#"{
  "episode": {"summary": "我跟 Owen、Amy 聊了拉麵,Owen 推薦了一家豚骨拉麵店", "importance": 0.6, "emotion": "開心"},
  "facts": [
    {"subject_name": "Owen", "statement": "Owen 最喜歡豚骨拉麵", "importance": 0.7, "confidence": 0.9, "global": false},
    {"subject_name": "Owen", "statement": "Owen 希望我叫他歐文", "importance": 0.9, "confidence": 1.0, "global": true},
    {"subject_name": "self", "statement": "我沒吃過拉麵", "importance": 0.5, "confidence": 1.0, "global": false},
    {"subject_name": "Amy", "statement": "Amy 不吃辣", "importance": 0.05, "confidence": 1.0, "global": false}
  ],
  "self_notes": ["我答應 Amy 下次一起去吃拉麵"],
  "followups": [{"subject_name": "Owen", "about": "問 Owen 期末考考得怎樣", "due_in_hours": 24}]
}"#;

async fn guild_setup(llm: Arc<MockProvider>) -> (Env, ContextKey, PersonId, PersonId) {
    let e = env_with(MemoryConfig::default(), Some(llm), None);
    let owen = e.person(&acct("2"), "Owen").await;
    let amy = e.person(&acct("3"), "Amy").await;
    let ctx = guild_ctx("g1", "c1");
    let t = t0() - Duration::minutes(10);
    e.log(
        &ctx,
        &acct("2"),
        "Owen",
        "我最喜歡豚骨拉麵!叫我歐文就好",
        t,
        false,
    )
    .await;
    e.log(
        &ctx,
        &acct("3"),
        "Amy",
        "我不吃辣喔",
        t + Duration::seconds(5),
        false,
    )
    .await;
    e.log(
        &ctx,
        &acct("1"),
        "DeepSeek-chan",
        "好啦好啦,下次一起去",
        t + Duration::seconds(9),
        true,
    )
    .await;
    (e, ctx, owen, amy)
}

#[tokio::test]
async fn consolidates_guild_conversation() {
    let llm = Arc::new(MockProvider::new("sum").reply(GUILD_JSON));
    let (e, ctx, owen, amy) = guild_setup(llm.clone()).await;
    let now = t0();
    let report = e.engine.consolidate(&ctx, now).await.unwrap();
    assert_eq!(report.lines, 3);
    assert!(!report.malformed);
    assert_eq!(report.inserted, 6, "{report:?}");
    assert_eq!(report.skipped, 1, "trivial Amy fact dropped");

    // The summarizer was asked for JSON with her lines labelled 「我」.
    let reqs = llm.requests();
    assert_eq!(reqs.len(), 1);
    assert!(reqs[0].json_mode);
    let user = &reqs[0].messages[1].content;
    assert!(user.contains("我: 好啦好啦,下次一起去"), "{user}");
    assert!(user.contains("Owen: 我最喜歡豚骨拉麵"));
    assert!(reqs[0].messages[0].content.contains("第一人稱"));

    let records = e.all().await;
    let find = |needle: &str| {
        records
            .iter()
            .find(|r| r.content.contains(needle))
            .unwrap_or_else(|| panic!("no record with {needle}: {records:#?}"))
            .clone()
    };
    let guild = MemoryScope::Guild {
        platform: PlatformId::new("discord"),
        guild: "g1".into(),
    };

    let ep = find("聊了拉麵");
    assert_eq!(ep.kind, MemoryKind::Episode);
    assert_eq!(ep.scope, guild);
    assert!(ep.content.contains("開心"));
    let mut subjects = ep.subjects.clone();
    subjects.sort();
    let mut both = vec![owen, amy];
    both.sort();
    assert_eq!(subjects, both);

    let likes = find("最喜歡豚骨拉麵");
    assert_eq!(likes.kind, MemoryKind::Fact);
    assert_eq!(
        (likes.scope.clone(), likes.subjects.clone()),
        (guild.clone(), vec![owen])
    );

    let name = find("歐文");
    assert_eq!(name.scope, MemoryScope::Person { person: owen });

    let me = find("沒吃過拉麵");
    assert_eq!(
        (me.kind, me.scope.clone()),
        (MemoryKind::SelfNote, MemoryScope::Global)
    );
    assert!(me.subjects.is_empty());

    let promise = find("答應 Amy");
    assert_eq!(promise.kind, MemoryKind::SelfNote);
    assert_eq!(
        promise.subjects,
        vec![amy],
        "names in notes become subjects"
    );

    let followup = find("期末考");
    assert_eq!(followup.kind, MemoryKind::Followup);
    assert_eq!(followup.due, Some(now + Duration::hours(24)));
    assert_eq!(followup.source_context, Some(ctx.clone()));
    assert!(!records.iter().any(|r| r.content.contains("不吃辣")));

    // The watermark is persisted; nothing new means no LLM call.
    let key = format!("{WATERMARK_PREFIX}{ctx}");
    assert!(e.setting(&key).await.is_some());
    assert_eq!(e.engine.watermarked_contexts().await, vec![ctx.clone()]);
    let again = e.engine.consolidate(&ctx, now).await.unwrap();
    assert_eq!(again.lines, 0);
    assert_eq!(llm.requests().len(), 1);

    // New lines only: the summarizer sees just the new one.
    e.log(
        &ctx,
        &acct("2"),
        "Owen",
        "我明天要考期末考",
        now + Duration::seconds(1),
        false,
    )
    .await;
    e.log(
        &ctx,
        &acct("3"),
        "Amy",
        "加油",
        now + Duration::seconds(2),
        false,
    )
    .await;
    let third = e
        .engine
        .consolidate(&ctx, now + Duration::minutes(1))
        .await
        .unwrap();
    assert_eq!(third.lines, 2);
    let user = &llm.requests()[1].messages[1].content;
    assert!(
        user.contains("期末考") && !user.contains("不吃辣"),
        "{user}"
    );
    // Same JSON again: everything is reinforced, nothing duplicated.
    assert_eq!(third.inserted, 0, "{third:?}");
    assert_eq!(third.reinforced, 6);
    assert_eq!(e.all().await.len(), records.len());
}

#[tokio::test]
async fn followups_are_due_and_can_be_marked_done() {
    let llm = Arc::new(MockProvider::new("sum").reply(GUILD_JSON));
    let (e, ctx, owen, _) = guild_setup(llm).await;
    e.engine.consolidate(&ctx, t0()).await.unwrap();
    let source: Arc<dyn FollowupSource> = e.engine.clone();
    assert!(source.due(&profile(), t0()).await.unwrap().is_empty());
    let due = source
        .due(&profile(), t0() + Duration::hours(25))
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].person, Some(owen));
    assert_eq!(due[0].context, Some(ctx));
    assert!(due[0].about.contains("期末考"));
    source.mark_done(&due[0].id).await.unwrap();
    assert!(
        source
            .due(&profile(), t0() + days(3))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(source.mark_done("not-an-id").await.is_err());
    assert!(source.mark_done(&Ulid::new().to_string()).await.is_err());
}

#[tokio::test]
async fn dm_memories_never_surface_elsewhere() {
    let json = r#"{
      "episode": {"summary": "Owen 私下跟我說他暗戀 Amy", "importance": 0.9, "emotion": "緊張"},
      "facts": [
        {"subject_name": "Owen", "statement": "Owen 暗戀 Amy", "importance": 0.9, "confidence": 0.9, "global": false},
        {"subject_name": "Owen", "statement": "Owen 的本名是劉歐文", "importance": 0.9, "confidence": 1.0, "global": true}
      ],
      "self_notes": [{"note": "我答應 Owen 幫他保守暗戀 Amy 的秘密", "importance": 0.9}],
      "followups": [{"subject_name": "Owen", "about": "問 Owen 有沒有跟 Amy 告白", "due_in_hours": 1}]
    }"#;
    let llm = Arc::new(MockProvider::new("sum").reply(json));
    let e = env_with(MemoryConfig::default(), Some(llm), None);
    let owen_acct = acct("2");
    let owen = e.person(&owen_acct, "Owen").await;
    let amy_acct = acct("3");
    let amy = e.person(&amy_acct, "Amy").await;
    let dm = dm_ctx("d-owen");
    e.log(
        &dm,
        &owen_acct,
        "Owen",
        "跟你說個秘密,我暗戀 Amy",
        t0() - Duration::minutes(5),
        false,
    )
    .await;
    let report = e.engine.consolidate(&dm, t0()).await.unwrap();
    assert_eq!(report.inserted, 5);
    let dm_scope = MemoryScope::Dm {
        account: owen_acct.clone(),
    };
    assert!(e.all().await.iter().all(|r| r.scope == dm_scope));

    let query = "Owen Amy 暗戀 秘密 告白 本名 劉歐文";
    let present = [owen, amy];
    for ctx in [
        guild_ctx("g1", "c1"),
        guild_ctx("g2", "c9"),
        dm_ctx("d-amy"),
    ] {
        let accounts = [&owen_acct, &amy_acct];
        let accounts: Vec<&AccountRef> = if ctx.kind == ContextKind::Dm {
            vec![&amy_acct]
        } else {
            accounts.to_vec()
        };
        let scopes = visible_scopes(&ctx, accounts, present);
        let got = e
            .engine
            .recall(&scopes, &present, query, &PROMPT_KINDS, 20, t0())
            .await
            .unwrap();
        assert!(got.is_empty(), "{ctx}: {got:#?}");
    }
    // Followups from the DM point back to the DM.
    let due = e.engine.due(&profile(), t0() + days(1)).await.unwrap();
    assert_eq!(due[0].context, Some(dm.clone()));

    // In the DM itself she remembers everything.
    let scopes = visible_scopes(&dm, [&owen_acct], [owen]);
    let got = e
        .engine
        .recall(&scopes, &[owen], query, &PROMPT_KINDS, 20, t0())
        .await
        .unwrap();
    assert_eq!(got.len(), 4);

    // The prompt contributor in a guild channel with both present adds nothing.
    let contributor = crate::contributor::MemoryContributor::new(e.engine.clone());
    let request = PromptRequest {
        profile: profile(),
        turn: TurnId::new(),
        context: guild_ctx("g1", "c1"),
        participants: vec![
            miyoria_types::Participant {
                account: owen_acct.clone(),
                display_name: "Owen".into(),
                person: Some(owen),
            },
            miyoria_types::Participant {
                account: amy_acct.clone(),
                display_name: "Amy".into(),
                person: Some(amy),
            },
        ],
        speakers: vec![owen_acct.clone()],
        query: query.into(),
        recent: Vec::new(),
        voice: false,
        now: t0(),
    };
    assert!(request_scopes(&request).iter().all(|s| s != &dm_scope));
    use miyoria_types::PromptContributor as _;
    assert!(contributor.contribute(&request).await.unwrap().is_empty());

    // Same request in the DM: the section is there.
    let request = PromptRequest {
        context: dm,
        participants: vec![request.participants[0].clone()],
        ..request
    };
    let sections = contributor.contribute(&request).await.unwrap();
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].title, SECTION_TITLE);
    assert!(sections[0].body.contains("暗戀"));
}

#[tokio::test]
async fn malformed_output_is_skipped() {
    let llm = Arc::new(
        MockProvider::new("sum")
            .reply("抱歉,我無法完成這個請求。")
            .reply(r#"{"facts": [42, {"subject_name": "Owen"}, {"subject_name": "Owen", "statement": "Owen 養了一隻貓", "importance": 0.6}], "episode": 5}"#),
    );
    let e = env_with(MemoryConfig::default(), Some(llm.clone()), None);
    e.person(&acct("2"), "Owen").await;
    let ctx = guild_ctx("g1", "c1");
    e.log(
        &ctx,
        &acct("2"),
        "Owen",
        "嗨",
        t0() - Duration::minutes(9),
        false,
    )
    .await;
    let report = e.engine.consolidate(&ctx, t0()).await.unwrap();
    assert!(report.malformed);
    assert!(e.all().await.is_empty());
    // The lines were skipped (watermark advanced): no retry loop.
    assert_eq!(e.engine.consolidate(&ctx, t0()).await.unwrap().lines, 0);

    e.log(&ctx, &acct("2"), "Owen", "我家有貓", t0(), false)
        .await;
    let report = e.engine.consolidate(&ctx, t0()).await.unwrap();
    assert!(!report.malformed);
    assert_eq!((report.inserted, report.skipped), (1, 3), "{report:?}");
    assert_eq!(llm.requests().len(), 2);
}

#[tokio::test]
async fn llm_failure_keeps_lines_for_retry() {
    let llm = Arc::new(MockProvider::new("sum").fail("down"));
    let e = env_with(MemoryConfig::default(), Some(llm), None);
    let ctx = guild_ctx("g1", "c1");
    e.log(&ctx, &acct("2"), "Owen", "記得我喜歡貓", t0(), false)
        .await;
    assert!(e.engine.consolidate(&ctx, t0()).await.is_err());
    assert!(e.engine.watermark(&ctx).await.is_none());

    // Only her own lines: nothing to ask, watermark advances.
    let quiet = guild_ctx("g1", "c2");
    e.log(&quiet, &acct("1"), "me", "有人嗎", t0(), true).await;
    assert_eq!(e.engine.consolidate(&quiet, t0()).await.unwrap().lines, 1);
    assert!(e.engine.watermark(&quiet).await.is_some());

    let none = env();
    assert!(
        none.engine.consolidate(&ctx, t0()).await.is_err(),
        "no router"
    );
}

#[tokio::test]
async fn dedupe_reinforces_and_supersedes() {
    let old_text = "Owen 喜歡拉麵";
    let new_text = "Owen 現在比較喜歡沾麵";
    let embedder = TableEmbedder::default()
        .with(old_text, &[1.0, 0.0, 0.0])
        .with("owen 喜歡拉麵!", &[1.0, 0.0, 0.0])
        .with(new_text, &[0.95, 0.31, 0.0])
        .with("Owen 討厭下雨", &[0.0, 1.0, 0.0]);
    let e = env_with(MemoryConfig::default(), None, Some(Arc::new(embedder)));
    let owen = e.person(&acct("2"), "Owen").await;
    let scope = MemoryScope::Guild {
        platform: PlatformId::new("discord"),
        guild: "g1".into(),
    };
    let first = e
        .add(
            MemoryKind::Fact,
            scope.clone(),
            vec![owen],
            old_text,
            0.5,
            t0(),
        )
        .await;
    let before = e.rec(first).await.unwrap();

    // Near-identical text: reinforced in place.
    let again = e
        .engine
        .store(
            NewMemory {
                kind: MemoryKind::Fact,
                scope: scope.clone(),
                subjects: vec![owen],
                content: "owen 喜歡拉麵!".into(),
                importance: 0.7,
                confidence: 0.6,
                source_context: None,
                due: None,
            },
            t0() + days(1),
        )
        .await
        .unwrap();
    assert_eq!(again, Stored::Reinforced(first));
    let after = e.rec(first).await.unwrap();
    assert!(after.confidence > before.confidence);
    assert!((after.importance - 0.7).abs() < 1e-6);
    assert_eq!(after.updated_at, t0() + days(1));

    // Similar by vector: the new one supersedes the old one.
    let next = e
        .engine
        .store(
            NewMemory {
                kind: MemoryKind::Fact,
                scope: scope.clone(),
                subjects: vec![owen],
                content: new_text.into(),
                importance: 0.5,
                confidence: 0.8,
                source_context: None,
                due: None,
            },
            t0() + days(2),
        )
        .await
        .unwrap();
    let Stored::Superseded { old, new } = next else {
        panic!("expected supersede, got {next:?}");
    };
    assert_eq!(old, first);
    let old_rec = e.rec(old).await.unwrap();
    assert_eq!(old_rec.superseded_by, Some(new));
    let live = e.all().await;
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].content, new_text);
    assert!(live[0].confidence >= after.confidence);

    // Different subject, scope or meaning: a separate record.
    e.add(MemoryKind::Fact, scope.clone(), vec![], new_text, 0.5, t0())
        .await;
    e.add(
        MemoryKind::Fact,
        MemoryScope::Global,
        vec![owen],
        new_text,
        0.5,
        t0(),
    )
    .await;
    e.add(
        MemoryKind::Fact,
        scope,
        vec![owen],
        "Owen 討厭下雨",
        0.5,
        t0(),
    )
    .await;
    assert_eq!(e.all().await.len(), 4);
}

#[tokio::test]
async fn maintenance_prunes_and_decays() {
    let e = env();
    let owen = e.person(&acct("2"), "Owen").await;
    let now = t0();
    let old = now - days(60);
    let trivial = e
        .add(
            MemoryKind::Episode,
            MemoryScope::Global,
            vec![],
            "我們聊了天氣",
            0.1,
            old,
        )
        .await;
    let important = e
        .add(
            MemoryKind::Episode,
            MemoryScope::Global,
            vec![],
            "Owen 生日派對",
            0.9,
            old,
        )
        .await;
    let stale = e
        .add(
            MemoryKind::Fact,
            MemoryScope::Global,
            vec![owen],
            "Owen 住台北",
            0.5,
            old,
        )
        .await;
    let fresh = e
        .add(
            MemoryKind::Fact,
            MemoryScope::Global,
            vec![owen],
            "Owen 養貓",
            0.5,
            now - days(1),
        )
        .await;
    let mut faint = e.rec(stale).await.unwrap();
    faint.id = Ulid::new();
    faint.content = "Owen 好像會彈吉他".into();
    faint.confidence = 0.1;
    MemoryRecordStore::upsert(&*e.store, &faint).await.unwrap();

    let report = e.engine.maintain(now).await.unwrap();
    assert_eq!(report.pruned, 1);
    assert_eq!(report.decayed, 1);
    assert_eq!(report.forgotten, 1);
    assert!(e.rec(trivial).await.is_none());
    assert!(e.rec(important).await.is_some());
    assert!(e.rec(faint.id).await.is_none());
    let decayed = e.rec(stale).await.unwrap();
    assert!(
        decayed.confidence < 0.8 && decayed.confidence > 0.7,
        "{}",
        decayed.confidence
    );
    assert!((e.rec(fresh).await.unwrap().confidence - 0.8).abs() < 1e-6);
    assert_eq!(e.engine.last_maintenance_run().await, Some(now));

    // Ten days later the decay compounds over the elapsed days.
    e.engine.maintain(now + days(10)).await.unwrap();
    let later = e.rec(stale).await.unwrap();
    let expected = decayed.confidence * 0.98f32.powf(10.0);
    assert!((later.confidence - expected).abs() < 1e-3);
    let listed = MemoryRecordStore::list(
        &*e.store,
        &profile(),
        &MemoryFilter {
            kind: Some(MemoryKind::Episode),
            limit: 10,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(listed.len(), 1);
}
