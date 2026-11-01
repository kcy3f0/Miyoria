//! The module under a supervisor: services, registrations, commands and
//! event-driven consolidation.

use std::collections::BTreeMap;
use std::time::Duration as StdDuration;

use async_trait::async_trait;
use miyoria_commands::{ArgValue, CommandRegistry, CommandsModule, Invocation};
use miyoria_kernel::{
    EventBus, Module, ModuleContext, ModuleManifest, ServiceRegistry, Supervisor,
};
use miyoria_store::{MemoryKind, MemoryScope, SettingsStore};
use miyoria_tools::ToolRegistry;
use miyoria_types::{
    Author, Event, FollowupSource, IncomingMessage, MessageRef, ModuleId, PromptContributors,
};
use serde_json::json;

use super::*;
use crate::engine::MemoryEngine;

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

struct Harness {
    sup: Supervisor,
    store: Arc<MemoryStore>,
    contributors: Arc<PromptContributors>,
    tools: Arc<ToolRegistry>,
}

async fn harness(llm: Arc<MockProvider>, config: serde_json::Value) -> Harness {
    let services = Arc::new(ServiceRegistry::new());
    let sup = Supervisor::new(EventBus::default(), services.clone());
    let app = ModuleId::from("app");
    let store = Arc::new(MemoryStore::new());
    services.provide::<dyn MemoryRecordStore>(&app, store.clone());
    services.provide::<dyn MessageLog>(&app, store.clone());
    services.provide::<dyn PeopleStore>(&app, store.clone());
    services.provide::<dyn SettingsStore>(&app, store.clone());
    let contributors = Arc::new(PromptContributors::new());
    services.provide(&app, contributors.clone());
    let tools = Arc::new(ToolRegistry::new());
    services.provide(&app, tools.clone());

    sup.register(
        Arc::new(LlmStub {
            manifest: ModuleManifest::new("llm", "LLM stub"),
            router: router(llm),
        }),
        serde_json::Value::Null,
        true,
    )
    .await;
    sup.register(
        Arc::new(CommandsModule::new()),
        json!({ "owners": ["discord:1"] }),
        true,
    )
    .await;
    sup.register(
        Arc::new(crate::MemoryModule::new(
            profile(),
            crate::EmbeddingConfig::default(),
        )),
        config,
        true,
    )
    .await;
    sup.start_all().await.unwrap();
    Harness {
        sup,
        store,
        contributors,
        tools,
    }
}

fn inv(path: &str, invoker: &str, context: ContextKey, args: &[(&str, &str)]) -> Invocation {
    Invocation {
        path: path.split_whitespace().map(str::to_owned).collect(),
        args: args
            .iter()
            .map(|(k, v)| ((*k).to_owned(), ArgValue::String((*v).to_owned())))
            .collect::<BTreeMap<_, _>>(),
        invoker: acct(invoker),
        invoker_display_name: invoker.to_owned(),
        context,
        invoker_is_guild_admin: false,
        platform_roles: Vec::new(),
        resolved_users: BTreeMap::new(),
    }
}

impl Harness {
    fn engine(&self) -> Arc<MemoryEngine> {
        self.sup.services().require::<MemoryEngine>().unwrap()
    }

    async fn run(&self, invocation: Invocation) -> String {
        let reg = self.sup.services().require::<CommandRegistry>().unwrap();
        let reply = reg.dispatch(invocation).await.unwrap();
        assert!(reply.ephemeral);
        reply.text
    }

    async fn add(
        &self,
        kind: MemoryKind,
        scope: MemoryScope,
        subjects: Vec<PersonId>,
        content: &str,
    ) {
        self.engine()
            .store(
                NewMemory {
                    kind,
                    scope,
                    subjects,
                    content: content.to_owned(),
                    importance: 0.5,
                    confidence: 0.8,
                    source_context: None,
                    due: None,
                },
                Utc::now(),
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn registers_services_and_unregisters_on_stop() {
    let h = harness(
        Arc::new(MockProvider::new("sum").reply("{}")),
        json!({ "tick_secs": 1 }),
    )
    .await;
    assert!(h.sup.services().get::<dyn FollowupSource>().is_some());
    assert!(h.sup.services().get::<MemoryEngine>().is_some());
    assert_eq!(h.contributors.all().len(), 1);
    assert_eq!(h.contributors.all()[0].key(), "memory");
    assert_eq!(h.tools.names(), vec!["recall", "remember"]);
    let reg = h.sup.services().require::<CommandRegistry>().unwrap();
    for path in crate::commands::PATHS {
        let spec = reg.get(&path.split(' ').map(str::to_owned).collect::<Vec<_>>());
        let spec = spec.unwrap_or_else(|| panic!("{path} not registered"));
        assert!(spec.permission.starts_with("memory.self."));
        assert!(spec.ephemeral);
    }

    h.sup.disable(&ModuleId::from("memory")).await.unwrap();
    assert!(h.contributors.all().is_empty());
    assert!(h.tools.is_empty());
    assert!(reg.get(&["memory".into(), "show".into()]).is_none());
    assert!(h.sup.services().get::<dyn FollowupSource>().is_none());

    // Restarting the commands module re-registers the commands.
    h.sup.enable(&ModuleId::from("memory")).await.unwrap();
    h.sup.restart(&ModuleId::from("commands")).await.unwrap();
    let fresh = h.sup.services().require::<CommandRegistry>().unwrap();
    assert!(!Arc::ptr_eq(&reg, &fresh));
    let deadline = tokio::time::Instant::now() + StdDuration::from_secs(5);
    while fresh.get(&["memory".into(), "show".into()]).is_none() {
        assert!(tokio::time::Instant::now() < deadline, "not re-registered");
        tokio::time::sleep(StdDuration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn memory_commands_show_forget_export() {
    let h = harness(Arc::new(MockProvider::new("sum").reply("{}")), json!({})).await;
    let owen_acct = acct("2");
    let owen = h.store.upsert_account(&owen_acct, "Owen").await.unwrap();
    let amy = h.store.upsert_account(&acct("3"), "Amy").await.unwrap();
    let g1 = MemoryScope::Guild {
        platform: PlatformId::new("discord"),
        guild: "g1".into(),
    };
    let dm_scope = MemoryScope::Dm {
        account: owen_acct.clone(),
    };
    h.add(MemoryKind::Fact, g1.clone(), vec![owen], "Owen 喜歡拉麵")
        .await;
    h.add(
        MemoryKind::Fact,
        dm_scope.clone(),
        vec![owen],
        "Owen 下週要看牙醫",
    )
    .await;
    h.add(
        MemoryKind::Fact,
        MemoryScope::Person { person: owen },
        vec![owen],
        "Owen 希望被叫歐文",
    )
    .await;
    h.add(MemoryKind::Fact, g1.clone(), vec![amy], "Amy 養貓")
        .await;

    let guild = guild_ctx("g1", "c1");
    let dm = dm_ctx("d-owen");

    let shown = h.run(inv("memory show", "2", guild.clone(), &[])).await;
    assert!(shown.contains("拉麵") && shown.contains("歐文"), "{shown}");
    assert!(
        !shown.contains("牙醫"),
        "DM memory shown in a guild: {shown}"
    );
    assert!(!shown.contains("Amy"));
    let shown = h.run(inv("memory show", "2", dm.clone(), &[])).await;
    assert!(shown.contains("牙醫"), "{shown}");
    assert!(!shown.contains("拉麵"), "guild memory shown in a DM");
    let other_guild = h
        .run(inv("memory show", "2", guild_ctx("g2", "c1"), &[]))
        .await;
    assert!(other_guild.contains("歐文") && !other_guild.contains("拉麵"));

    let exported = h.run(inv("memory export", "2", guild.clone(), &[])).await;
    let json_text = exported
        .trim_start_matches("```json\n")
        .trim_end_matches("\n```");
    let items: Vec<serde_json::Value> = serde_json::from_str(json_text).unwrap();
    assert_eq!(items.len(), 2, "{exported}");
    assert!(items.iter().all(|i| i["kind"] == "fact"));

    // Someone else's memories need memory.admin.*.
    let denied = h
        .run(inv("memory show", "3", guild.clone(), &[("user", "<@2>")]))
        .await;
    assert!(denied.contains("管理員"), "{denied}");
    let mut as_admin = inv("memory show", "3", guild.clone(), &[("user", "<@2>")]);
    as_admin.invoker_is_guild_admin = true;
    assert!(h.run(as_admin).await.contains("拉麵"));
    let owner = h
        .run(inv(
            "memory show",
            "1",
            guild.clone(),
            &[("user", "discord:2")],
        ))
        .await;
    assert!(owner.contains("拉麵") && !owner.contains("牙醫"), "{owner}");
    let bad = h
        .run(inv("memory show", "1", guild.clone(), &[("user", "a b")]))
        .await;
    assert!(bad.contains("使用者"), "{bad}");

    // Forget by keyword (everywhere, including the DM), then everything.
    let forgot = h
        .run(inv(
            "memory forget",
            "2",
            guild.clone(),
            &[("target", "牙醫")],
        ))
        .await;
    assert!(forgot.contains('1'), "{forgot}");
    let none = h
        .run(inv(
            "memory forget",
            "2",
            guild.clone(),
            &[("target", "火星")],
        ))
        .await;
    assert!(none.contains("不記得"), "{none}");
    let all = h
        .run(inv("memory forget", "2", dm.clone(), &[("target", "all")]))
        .await;
    assert!(all.contains("全部忘掉"), "{all}");
    let engine = h.engine();
    assert!(
        engine
            .memories_of(Some(owen), &owen_acct, true)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        engine
            .memories_of(Some(amy), &acct("3"), false)
            .await
            .unwrap()
            .len(),
        1,
        "Amy's memories untouched"
    );
    let empty = h.run(inv("memory show", "2", guild, &[])).await;
    assert!(empty.contains("還沒記得"), "{empty}");
}

#[tokio::test]
async fn consolidates_after_enough_messages() {
    let reply = r#"{"facts": [{"subject_name": "Owen", "statement": "Owen 養了一隻叫麻糬的貓", "importance": 0.7, "confidence": 0.9, "global": false}]}"#;
    let llm = Arc::new(MockProvider::new("sum").reply(reply));
    let h = harness(
        llm.clone(),
        json!({ "tick_secs": 1, "consolidate_every_messages": 2, "consolidate_idle_secs": 3600 }),
    )
    .await;
    let owen = acct("2");
    h.store.upsert_account(&owen, "Owen").await.unwrap();
    let ctx = guild_ctx("g1", "c1");
    for (i, text) in ["我家有貓", "牠叫麻糬"].iter().enumerate() {
        let msg = IncomingMessage {
            id: MessageRef {
                context: ctx.clone(),
                id: format!("m{i}"),
            },
            author: Author {
                account: owen.clone(),
                display_name: "Owen".into(),
                is_bot: false,
            },
            text: (*text).to_owned(),
            mentions_self: false,
            reply_to_self: false,
            attachments: Vec::new(),
            ts: Utc::now(),
        };
        // The recorder would append it; do it here.
        h.store
            .append(&LogEntry::from_incoming(profile(), &msg, false))
            .await
            .unwrap();
        h.sup.bus().publish(
            &ModuleId::from("test"),
            Event::PlatformMessageCreated(msg),
            None,
        );
    }
    let deadline = tokio::time::Instant::now() + StdDuration::from_secs(10);
    loop {
        let records = h.engine().memories_of(None, &owen, false).await.unwrap();
        let all = MemoryRecordStore::list(
            &*h.store,
            &profile(),
            &miyoria_store::MemoryFilter {
                limit: 10,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        if let Some(r) = all.first() {
            assert!(r.content.contains("麻糬"));
            assert_eq!(
                r.scope,
                MemoryScope::Guild {
                    platform: PlatformId::new("discord"),
                    guild: "g1".into()
                }
            );
            assert!(records.is_empty(), "no DM-scoped records");
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "not consolidated");
        tokio::time::sleep(StdDuration::from_millis(100)).await;
    }
    assert_eq!(llm.requests().len(), 1);
    let user = &llm.requests()[0].messages[1].content;
    assert!(user.contains("我家有貓") && user.contains("牠叫麻糬"));
}
