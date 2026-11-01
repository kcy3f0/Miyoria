//! Hybrid recall, the prompt section and the model tools.

use miyoria_store::{MemoryKind, MemoryScope};
use miyoria_tools::{Tool, ToolContext};
use miyoria_types::{MessageRef, Priority, TurnId};
use serde_json::json;

use super::*;
use crate::config::{MemoryConfig, Weights};
use crate::contributor::{PROMPT_KINDS, format_lines};
use crate::scope::visible_scopes;
use crate::tools::{RecallTool, RememberTool};

fn g1() -> MemoryScope {
    MemoryScope::Guild {
        platform: PlatformId::new("discord"),
        guild: "g1".into(),
    }
}

#[tokio::test]
async fn ranks_by_text_subject_recency_and_importance() {
    let e = env();
    let owen = e.person(&acct("2"), "Owen").await;
    let amy = e.person(&acct("3"), "Amy").await;
    let now = t0();
    let ramen = e
        .add(
            MemoryKind::Fact,
            g1(),
            vec![owen],
            "Owen 喜歡拉麵",
            0.5,
            now - days(3),
        )
        .await;
    let cat = e
        .add(
            MemoryKind::Fact,
            g1(),
            vec![amy],
            "Amy 養了一隻貓",
            0.9,
            now - days(1),
        )
        .await;
    let old_ramen = e
        .add(
            MemoryKind::Episode,
            g1(),
            vec![],
            "大家去吃拉麵那天下大雨",
            0.5,
            now - days(90),
        )
        .await;
    let new_ramen = e
        .add(
            MemoryKind::Episode,
            g1(),
            vec![],
            "大家又去吃拉麵",
            0.5,
            now - days(1),
        )
        .await;
    let scopes = visible_scopes(&guild_ctx("g1", "c1"), [&acct("2")], [owen]);

    let got = e
        .engine
        .recall(&scopes, &[owen], "拉麵", &PROMPT_KINDS, 8, now)
        .await
        .unwrap();
    let ids: Vec<Ulid> = got.iter().map(|r| r.record.id).collect();
    assert_eq!(ids[0], ramen, "text + subject wins: {got:#?}");
    let pos = |id| ids.iter().position(|x| *x == id).unwrap();
    assert!(pos(new_ramen) < pos(old_ramen), "recency breaks the tie");
    assert!(!ids.contains(&cat), "no match and not present");
    assert!(got.windows(2).all(|w| w[0].score >= w[1].score));

    // Present people are candidates even without a text match.
    let got = e
        .engine
        .recall(&scopes, &[owen, amy], "早安", &PROMPT_KINDS, 8, now)
        .await
        .unwrap();
    let ids: Vec<Ulid> = got.iter().map(|r| r.record.id).collect();
    assert_eq!(ids, vec![cat, ramen], "importance and recency order them");

    // Recalled records are touched; the limit applies.
    let got = e
        .engine
        .recall(&scopes, &[owen], "拉麵", &PROMPT_KINDS, 1, now)
        .await
        .unwrap();
    assert_eq!(got.len(), 1);
    let touched = e.rec(ramen).await.unwrap();
    assert_eq!(touched.access_count, 3);
    assert_eq!(touched.last_accessed, Some(now));

    // Only the requested kinds come back.
    let got = e
        .engine
        .recall(&scopes, &[owen], "拉麵", &[MemoryKind::Episode], 8, now)
        .await
        .unwrap();
    assert!(got.iter().all(|r| r.record.kind == MemoryKind::Episode));
}

#[tokio::test]
async fn vectors_find_matches_without_shared_words() {
    let embedder = TableEmbedder::default()
        .with("Owen 喜歡拉麵", &[1.0, 0.0, 0.0])
        .with("他愛吃什麼", &[0.9, 0.1, 0.0])
        .with("Amy 討厭下雨", &[0.0, 1.0, 0.0]);
    let config = MemoryConfig {
        weights: Weights {
            vector: 1.0,
            text: 0.0,
            recency: 0.0,
            importance: 0.0,
            subject: 0.0,
        },
        min_score: 0.5,
        ..MemoryConfig::default()
    };
    let e = env_with(config, None, Some(Arc::new(embedder)));
    let ramen = e
        .add(
            MemoryKind::Fact,
            MemoryScope::Global,
            vec![],
            "Owen 喜歡拉麵",
            0.5,
            t0(),
        )
        .await;
    e.add(
        MemoryKind::Fact,
        MemoryScope::Global,
        vec![],
        "Amy 討厭下雨",
        0.5,
        t0(),
    )
    .await;
    let got = e
        .engine
        .recall(
            &[MemoryScope::Global],
            &[],
            "他愛吃什麼",
            &PROMPT_KINDS,
            8,
            t0(),
        )
        .await
        .unwrap();
    assert_eq!(got.len(), 1, "{got:#?}");
    assert_eq!(got[0].record.id, ramen);
    assert!(
        got[0].score > 0.85,
        "cosine ~0.99 scaled by fact confidence"
    );
}

#[tokio::test]
async fn prompt_lines_have_relative_dates() {
    let e = env();
    let id = e
        .add(
            MemoryKind::Fact,
            MemoryScope::Global,
            vec![],
            "Owen 喜歡拉麵",
            0.5,
            t0() - days(3),
        )
        .await;
    let record = e.rec(id).await.unwrap();
    let lines = format_lines(&[crate::engine::Recalled { record, score: 1.0 }], t0());
    assert_eq!(lines, "- Owen 喜歡拉麵(三天前)");
}

fn tool_ctx(context: ContextKey, account: AccountRef) -> ToolContext {
    ToolContext {
        turn: TurnId::new(),
        message: MessageRef {
            context: context.clone(),
            id: "m1".into(),
        },
        context,
        account,
        priority: Priority::Direct,
    }
}

#[tokio::test]
async fn remember_and_recall_tools_respect_scopes() {
    let e = env();
    let owen_acct = acct("2");
    let owen = e.person(&owen_acct, "Owen").await;
    let remember = RememberTool::new(e.engine.clone());
    let recall = RecallTool::new(e.engine.clone());
    let dm = tool_ctx(dm_ctx("d1"), owen_acct.clone());
    let guild = tool_ctx(guild_ctx("g1", "c1"), owen_acct.clone());

    let out = remember
        .call(
            &dm,
            json!({ "content": "Owen 下週三要看牙醫", "importance": 0.8 }),
        )
        .await
        .unwrap();
    assert_eq!(out, "記住了。");
    let out = remember
        .call(&guild, json!({ "content": "Owen 喜歡 Minecraft" }))
        .await
        .unwrap();
    assert_eq!(out, "記住了。");
    let out = remember
        .call(
            &guild,
            json!({ "content": "我答應要學做蛋糕", "about": "self" }),
        )
        .await
        .unwrap();
    assert_eq!(out, "記住了。");
    let again = remember
        .call(&guild, json!({ "content": "Owen 喜歡 Minecraft!" }))
        .await
        .unwrap();
    assert!(again.contains("本來就記得"), "{again}");
    assert!(remember.call(&guild, json!({})).await.is_err());

    let records = e.all().await;
    let find = |needle: &str| records.iter().find(|r| r.content.contains(needle)).unwrap();
    assert_eq!(
        find("牙醫").scope,
        MemoryScope::Dm {
            account: owen_acct.clone()
        }
    );
    assert_eq!(find("牙醫").subjects, vec![owen]);
    assert_eq!(find("Minecraft").scope, g1());
    assert_eq!(find("蛋糕").kind, MemoryKind::SelfNote);
    assert_eq!(find("蛋糕").scope, MemoryScope::Global);

    let in_guild = recall
        .call(&guild, json!({ "query": "牙醫 Minecraft" }))
        .await
        .unwrap();
    assert!(in_guild.contains("Minecraft"), "{in_guild}");
    assert!(!in_guild.contains("牙醫"), "DM note leaked: {in_guild}");
    let in_dm = recall.call(&dm, json!({ "query": "牙醫" })).await.unwrap();
    assert!(in_dm.contains("牙醫"), "{in_dm}");
    let other_guild = tool_ctx(guild_ctx("g2", "c1"), acct("9"));
    let out = recall
        .call(&other_guild, json!({ "query": "Minecraft 牙醫" }))
        .await
        .unwrap();
    assert_eq!(out, "想不起來有關的事。");
}
