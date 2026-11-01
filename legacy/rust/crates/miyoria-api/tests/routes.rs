//! Route groups added for the admin panel: a real supervisor running the
//! `api` module, an in-memory store, and the real module services where they
//! are cheap to build (social engine, auth service, request queue, MCP
//! status, extension catalog, stage link) plus a fake voice sink.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use miyoria_api::types::{
    AssignRoleRequest, MemoryListQuery, RemoveMappingRequest, UpdateMemoryRequest,
    UpdatePersonRequest, UpsertRoleRequest,
};
use miyoria_api::{ApiClient, ApiModule, ClientError};
use miyoria_auth::AuthService;
use miyoria_ext_host::{CatalogEntry, ExtensionCatalog, ExtensionSpec};
use miyoria_kernel::{
    EventBus, Module, ModuleContext, ModuleManifest, ServiceRegistry, Supervisor, SupervisorHandle,
};
use miyoria_llm::LlmRouter;
use miyoria_mcp::McpStatus;
use miyoria_memory::tokenize::token_string;
use miyoria_queue::{QueueConfig, RequestQueue, SubmitRequest};
use miyoria_social::{Social, SocialConfig, SocialStores};
use miyoria_stage::{StageLinkModule, StreamAction};
use miyoria_store::{
    AuditEntry, AuditLog, AuthScope, AuthStore, IdentityStore, MemoryKind, MemoryRecord,
    MemoryRecordStore, MemoryScope, PeopleStore, RelationshipStore, RoleMapping, Store,
};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, Event, ModuleId, ModuleStateKind, PersonId, PlatformId,
    ProfileId, SpeakOutcome, TurnId, VoiceParticipant, VoiceSink,
};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use ulid::Ulid;

const TOKEN: &str = "test-token";
const PROFILE: &str = "test-chan";

struct Idle(ModuleManifest);

#[async_trait]
impl Module for Idle {
    fn manifest(&self) -> &ModuleManifest {
        &self.0
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let cancel = ctx.cancellation().clone();
        ctx.spawn("idle", async move {
            cancel.cancelled().await;
            Ok(())
        });
        Ok(())
    }
}

/// Records what it was asked to say.
struct FakeSink(mpsc::UnboundedSender<(ContextKey, String, Option<TurnId>)>);

#[async_trait]
impl VoiceSink for FakeSink {
    async fn speak(
        &self,
        context: &ContextKey,
        text: &str,
        _emotion: Option<&str>,
        turn: Option<TurnId>,
    ) -> anyhow::Result<SpeakOutcome> {
        let _ = self.0.send((context.clone(), text.to_owned(), turn));
        Ok(SpeakOutcome::Completed)
    }
}

struct Harness {
    sup: Supervisor,
    bus: EventBus,
    services: Arc<ServiceRegistry>,
    store: Store,
    social: Arc<Social>,
    queue: Arc<RequestQueue>,
    spoken: mpsc::UnboundedReceiver<(ContextKey, String, Option<TurnId>)>,
    client: ApiClient,
    base: String,
}

fn kernel() -> ModuleId {
    ModuleId::from("kernel")
}

fn catalog() -> ExtensionCatalog {
    let manifest = serde_json::from_value(json!({
        "id": "demo",
        "version": "0.2.1",
        "name": "Demo",
        "description": "Says hi",
        "runtime": "node",
        "entry": "index.mjs",
    }))
    .unwrap();
    let granted = serde_json::from_value(json!({ "tools": true, "events": ["game.*"] })).unwrap();
    ExtensionCatalog {
        entries: vec![CatalogEntry {
            spec: ExtensionSpec {
                manifest,
                dir: std::path::PathBuf::from("extensions/demo"),
                granted,
            },
            enabled: true,
        }],
    }
}

async fn harness_with(api_config: Value) -> Harness {
    let bus = EventBus::default();
    let services = Arc::new(ServiceRegistry::new());
    let sup = Supervisor::new(bus.clone(), services.clone());
    let store = Store::memory();
    let k = kernel();
    services.provide::<SupervisorHandle>(&k, Arc::new(sup.clone()));
    services.provide(&k, Arc::new(ProfileId::from(PROFILE)));
    services.provide::<dyn PeopleStore>(&k, store.people.clone());
    services.provide::<dyn RelationshipStore>(&k, store.relationships.clone());
    services.provide::<dyn IdentityStore>(&k, store.identity.clone());
    services.provide::<dyn MemoryRecordStore>(&k, store.memories.clone());
    services.provide::<dyn AuthStore>(&k, store.auth.clone());
    services.provide::<dyn AuditLog>(&k, store.audit.clone());
    services.provide(
        &ModuleId::from("llm"),
        Arc::new(LlmRouter::new(HashMap::new(), HashMap::new())),
    );

    let social = Arc::new(Social::new(
        ProfileId::from(PROFILE),
        "Test",
        Vec::new(),
        SocialConfig::default(),
        SocialStores {
            people: store.people.clone(),
            relationships: store.relationships.clone(),
            identity: Some(store.identity.clone()),
        },
        Arc::new(|_| {}),
    ));
    services.provide(&ModuleId::from("social"), social.clone());

    let auth = AuthService::load(
        store.auth.clone(),
        Some(store.audit.clone()),
        Vec::new(),
        "user",
    )
    .await
    .unwrap();
    services.provide(&ModuleId::from("auth"), auth);

    let queue = Arc::new(RequestQueue::new(QueueConfig::default()));
    services.provide(&ModuleId::from("queue"), queue.clone());
    services.provide(&ModuleId::from("mcp"), Arc::new(McpStatus::new()));
    services.provide(&ModuleId::from("extensions"), Arc::new(catalog()));

    let (tx, spoken) = mpsc::unbounded_channel();
    services.provide::<dyn VoiceSink>(&ModuleId::from("voice"), Arc::new(FakeSink(tx)));

    let api = Arc::new(ApiModule::new());
    let mut config = json!({ "bind": "127.0.0.1:0", "token": TOKEN, "panel_dir": "" });
    if let (Some(c), Some(extra)) = (config.as_object_mut(), api_config.as_object()) {
        c.extend(extra.clone());
    }
    sup.register(api.clone(), config, true).await;
    sup.register(
        Arc::new(Idle(ModuleManifest::new("ext.demo", "Demo"))),
        Value::Null,
        true,
    )
    .await;
    sup.start_all().await.unwrap();

    let base = format!("http://{}", api.local_addr().expect("api is running"));
    let client = ApiClient::new(&base, TOKEN).unwrap();
    Harness {
        sup,
        bus,
        services,
        store,
        social,
        queue,
        spoken,
        client,
        base,
    }
}

async fn harness() -> Harness {
    harness_with(json!({})).await
}

fn status_of(err: &ClientError) -> StatusCode {
    err.status()
        .unwrap_or_else(|| panic!("expected an API error, got {err}"))
}

impl Harness {
    async fn raw(&self, method: reqwest::Method, path: &str) -> (StatusCode, Value) {
        let response = reqwest::Client::new()
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn audit(&self) -> Vec<AuditEntry> {
        self.store.audit.recent(100, Some("api")).await.unwrap()
    }

    async fn audited(&self, action: &str) -> AuditEntry {
        self.audit()
            .await
            .into_iter()
            .find(|e| e.action == action)
            .unwrap_or_else(|| panic!("no `{action}` audit entry"))
    }
}

fn account(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: id.to_owned(),
    }
}

fn voice_context() -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some("g1".into()),
        channel: "vc1".into(),
        kind: ContextKind::Voice,
    }
}

#[tokio::test]
async fn fallback_and_unavailable_shapes() {
    let h = harness().await;
    for path in ["/api/nope", "/api", "/api/people/x/nope", "/"] {
        let (status, body) = h.raw(reqwest::Method::GET, path).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(body, json!({ "error": "no such endpoint" }), "{path}");
    }
    // New routes are protected like the old ones.
    let anon = ApiClient::new(&h.base, "wrong").unwrap();
    let err = anon.queue().await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::UNAUTHORIZED);

    // A stopped module's service yields 503 with a JSON error.
    let (status, body) = h.raw(reqwest::Method::GET, "/api/stage").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"].as_str().unwrap().contains("stage link"));
    h.services.remove_owned_by(&ModuleId::from("llm"));
    let err = h.client.cost().await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::SERVICE_UNAVAILABLE);
    h.services.remove_owned_by(&ModuleId::from("queue"));
    let (status, body) = h.raw(reqwest::Method::GET, "/api/queue").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"].is_string());
    h.sup.stop_all().await;
}

#[tokio::test]
async fn llm_cost_report() {
    let h = harness().await;
    let cost = h.client.cost().await.unwrap();
    assert_eq!(cost.today.calls, 0);
    assert_eq!(cost.today.period.len(), "2026-11-01".len());
    assert_eq!(cost.month.period.len(), "2026-11".len());
    let (status, body) = h.raw(reqwest::Method::GET, "/api/llm/cost").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["state"], "ok");
    for key in ["daily_usd", "monthly_usd", "degrade_at", "today", "month"] {
        assert!(body.get(key).is_some(), "missing `{key}`");
    }
    h.sup.stop_all().await;
}

fn memory(person: Option<PersonId>, kind: MemoryKind, content: &str, minute: u32) -> MemoryRecord {
    let at = Utc.with_ymd_and_hms(2026, 10, 1, 12, minute, 0).unwrap();
    MemoryRecord {
        id: Ulid::new(),
        profile: ProfileId::from(PROFILE),
        kind,
        scope: match person {
            Some(person) => MemoryScope::Person { person },
            None => MemoryScope::Global,
        },
        subjects: person.into_iter().collect(),
        content: content.to_owned(),
        tokens: token_string(content),
        embedding: Some(vec![0.1, 0.2]),
        importance: 0.5,
        confidence: 0.9,
        created_at: at,
        updated_at: at,
        last_accessed: None,
        access_count: 0,
        source_context: None,
        due: None,
        done: false,
        superseded_by: None,
    }
}

#[tokio::test]
async fn people_list_detail_and_changes() {
    let h = harness().await;
    let c = &h.client;
    let now = Utc::now();
    let owen = h
        .store
        .people
        .upsert_account(&account("1"), "Owen")
        .await
        .unwrap();
    let mika = h
        .store
        .people
        .upsert_account(&account("2"), "Mika")
        .await
        .unwrap();
    h.social.adjust(owen, 10.0, "test", now).await.unwrap();
    h.social.adjust(owen, 5.0, "test", now).await.unwrap();
    h.social.adjust(mika, -3.0, "test", now).await.unwrap();
    h.store
        .memories
        .upsert(&memory(Some(owen), MemoryKind::Fact, "Owen 喜歡拉麵", 0))
        .await
        .unwrap();

    let page = c.people(None, None, None).await.unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.next_cursor, None);
    let page = c.people(Some("owe"), None, None).await.unwrap();
    assert_eq!(page.items.len(), 1);
    let summary = &page.items[0];
    assert_eq!(summary.person.id, owen);
    assert_eq!(summary.person.display_name, "Owen");
    assert_eq!(summary.person.accounts[0].account, account("1"));
    assert_eq!(summary.relationship.as_ref().unwrap().affinity, 15.0);
    assert!(summary.label.is_some());
    assert!(!summary.blocked);
    let page = c.people(None, Some(1), None).await.unwrap();
    assert_eq!(page.items.len(), 1);
    let cursor = page.next_cursor.expect("a second page");
    let page = c.people(None, Some(1), Some(&cursor)).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.next_cursor, None);

    let detail = c.person(&owen.to_string()).await.unwrap();
    let levels: Vec<f32> = detail.history.iter().map(|d| d.affinity).collect();
    assert_eq!(levels, [10.0, 15.0], "absolute levels, oldest first");
    assert_eq!(detail.memory_count, 1);
    let (_, raw) = h
        .raw(reqwest::Method::GET, &format!("/api/people/{owen}"))
        .await;
    assert!(
        raw.get("person").is_some() && raw.get("history").is_some(),
        "flattened"
    );

    let request = UpdatePersonRequest {
        tags: Some(vec!["常客".into(), " Minecraft ".into(), "常客".into()]),
        notes: Some("喜歡拉麵".into()),
        call_name: Some(Some("歐文".into())),
        blocked: Some(true),
    };
    let updated = c.update_person(&owen.to_string(), &request).await.unwrap();
    let rel = updated.relationship.unwrap();
    let mut tags = rel.tags.clone();
    tags.sort();
    assert_eq!(tags, ["Minecraft", "blocked", "常客"]);
    assert_eq!(rel.notes, "喜歡拉麵");
    assert_eq!(rel.call_name.as_deref(), Some("歐文"));
    assert!(updated.blocked);
    assert_eq!(
        h.social.relationship(owen).unwrap().notes,
        "喜歡拉麵",
        "the engine's cache sees the notes"
    );
    let entry = h.audited("person.update").await;
    assert_eq!(entry.target, owen.to_string());
    assert!(entry.ok);

    // `null` clears the call name; omitted fields stay.
    let raw = reqwest::Client::new()
        .patch(format!("{}/api/people/{owen}", h.base))
        .bearer_auth(TOKEN)
        .json(&json!({ "call_name": null, "blocked": false, "tags": ["常客"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(raw.status(), StatusCode::OK);
    let body: Value = raw.json().await.unwrap();
    assert_eq!(body["relationship"]["call_name"], Value::Null);
    assert_eq!(body["relationship"]["notes"], "喜歡拉麵");
    assert_eq!(body["relationship"]["tags"], json!(["常客"]));
    assert_eq!(body["blocked"], false);

    let adjusted = c.adjust_person(&mika.to_string(), 20.0).await.unwrap();
    assert_eq!(adjusted.relationship.unwrap().affinity, 17.0);
    h.audited("person.adjust").await;

    for id in [Ulid::new().to_string(), "nope".to_owned()] {
        let err = c.person(&id).await.unwrap_err();
        assert_eq!(status_of(&err), StatusCode::NOT_FOUND);
        assert!(err.to_string().contains("unknown person"), "{err}");
    }
    let err = c
        .update_person(&Ulid::new().to_string(), &UpdatePersonRequest::default())
        .await
        .unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND);

    h.services.remove_owned_by(&ModuleId::from("social"));
    let err = c
        .update_person(&owen.to_string(), &UpdatePersonRequest::default())
        .await
        .unwrap_err();
    assert_eq!(status_of(&err), StatusCode::SERVICE_UNAVAILABLE);
    // Reads still work from the stores.
    assert_eq!(c.people(None, None, None).await.unwrap().items.len(), 2);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn memory_list_search_edit_delete() {
    let h = harness().await;
    let c = &h.client;
    let owen = PersonId::new();
    let ramen = memory(Some(owen), MemoryKind::Fact, "Owen 喜歡 豚骨 拉麵", 1);
    let game = memory(None, MemoryKind::Episode, "大家 一起 玩 Minecraft", 2);
    let note = memory(None, MemoryKind::SelfNote, "我 想 學 拉麵 的 做法", 3);
    for r in [&ramen, &game, &note] {
        h.store.memories.upsert(r).await.unwrap();
    }

    let page = c.memory(&MemoryListQuery::default()).await.unwrap();
    let ids: Vec<Ulid> = page.items.iter().map(|i| i.record.id).collect();
    assert_eq!(ids, [note.id, game.id, ramen.id], "newest first");
    assert!(page.items[0].record.has_embedding);
    assert!(page.items.iter().all(|i| i.text_score.is_none()));
    let (_, raw) = h.raw(reqwest::Method::GET, "/api/memory").await;
    let first = &raw["items"][0];
    assert!(first.get("text_score").is_none() && first.get("vector_score").is_none());
    assert!(first["record"].get("tokens").is_none() && first["record"].get("embedding").is_none());
    assert_eq!(first["record"]["scope"], json!({ "type": "global" }));

    let page = c
        .memory(&MemoryListQuery {
            limit: Some(2),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.items.len(), 2);
    let before = page.next_cursor.expect("more").parse().unwrap();
    let page = c
        .memory(&MemoryListQuery {
            before: Some(before),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].record.id, ramen.id);

    let facts = c
        .memory(&MemoryListQuery {
            kind: Some(MemoryKind::Fact),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(facts.items.len(), 1);
    let about = c
        .memory(&MemoryListQuery {
            subject: Some(owen),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(about.items.len(), 1);

    // Search across all scopes (person and global), with scores.
    let hits = c
        .memory(&MemoryListQuery {
            q: Some("拉麵".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut found: Vec<Ulid> = hits.items.iter().map(|i| i.record.id).collect();
    found.sort();
    let mut want = vec![ramen.id, note.id];
    want.sort();
    assert_eq!(found, want);
    assert!(hits.items.iter().all(|i| i.text_score.unwrap() > 0.0));
    let (_, raw) = h.raw(reqwest::Method::GET, "/api/memory?q=Minecraft").await;
    assert_eq!(raw["items"].as_array().unwrap().len(), 1);
    assert!(raw["items"][0]["text_score"].as_f64().unwrap() > 0.0);
    assert_eq!(raw["items"][0]["vector_score"], Value::Null);

    let updated = c
        .update_memory(
            &ramen.id.to_string(),
            &UpdateMemoryRequest {
                content: Some("Owen 喜歡 豚骨 拉麵,不吃 香菜".into()),
                importance: Some(0.7),
                done: None,
                kind: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.content, "Owen 喜歡 豚骨 拉麵,不吃 香菜");
    assert_eq!(updated.importance, 0.7);
    assert!(!updated.has_embedding, "stale vector dropped");
    let stored = h.store.memories.get(ramen.id).await.unwrap().unwrap();
    assert!(
        stored.tokens.contains("香菜"),
        "re-tokenized: {}",
        stored.tokens
    );
    h.audited("memory.update").await;
    let err = c
        .update_memory(
            &ramen.id.to_string(),
            &UpdateMemoryRequest {
                importance: Some(3.0),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(status_of(&err), StatusCode::BAD_REQUEST);

    c.delete_memory(&game.id.to_string()).await.unwrap();
    assert!(h.store.memories.get(game.id).await.unwrap().is_none());
    let entry = h.audited("memory.delete").await;
    assert_eq!(entry.target, game.id.to_string());
    assert_eq!(entry.detail["content"], "大家 一起 玩 Minecraft");
    let err = c.delete_memory(&game.id.to_string()).await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND);
    assert!(err.to_string().contains("unknown memory"));
    h.sup.stop_all().await;
}

#[tokio::test]
async fn roles_assignments_and_mappings() {
    let h = harness().await;
    let c = &h.client;
    let roles = c.roles().await.unwrap();
    assert_eq!(roles[0].name, "owner");
    assert!(roles.iter().all(|r| r.builtin));
    assert_eq!(c.role("moderator").await.unwrap().rank, 60);
    assert_eq!(
        status_of(&c.role("ghost").await.unwrap_err()),
        StatusCode::NOT_FOUND
    );

    let request = AssignRoleRequest {
        account: account("123"),
        role: "moderator".into(),
        scope: AuthScope::Guild {
            platform: PlatformId::new("discord"),
            guild: "g1".into(),
        },
    };
    let created = c.assign_role(&request).await.unwrap();
    assert_eq!(created.granted_by, "api");
    assert_eq!(created.role, "moderator");
    let err = c.assign_role(&request).await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::CONFLICT);
    let err = c
        .assign_role(&AssignRoleRequest {
            role: "ghost".into(),
            ..request.clone()
        })
        .await
        .unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND);
    let all = c.assignments().await.unwrap();
    assert_eq!(all.len(), 1);
    let (_, raw) = h.raw(reqwest::Method::GET, "/api/auth/assignments").await;
    assert_eq!(raw[0]["scope"]["type"], "guild");
    h.audited("role.assign").await;

    c.revoke_role(&request).await.unwrap();
    assert!(c.assignments().await.unwrap().is_empty());
    let err = c.revoke_role(&request).await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND);
    h.audited("role.revoke").await;

    let custom = c
        .upsert_role(
            "dj",
            &UpsertRoleRequest {
                rank: 30,
                grants: vec!["queue.*".into()],
                denies: vec![],
            },
        )
        .await
        .unwrap();
    assert!(!custom.builtin);
    let err = c
        .upsert_role(
            "bad",
            &UpsertRoleRequest {
                rank: 1,
                grants: vec!["not a node!".into()],
                denies: vec![],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(status_of(&err), StatusCode::BAD_REQUEST);
    let err = c.delete_role("owner").await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::CONFLICT);
    c.delete_role("dj").await.unwrap();
    assert_eq!(
        status_of(&c.delete_role("dj").await.unwrap_err()),
        StatusCode::NOT_FOUND
    );

    let mapping = RoleMapping {
        platform: PlatformId::new("discord"),
        guild: "g1".into(),
        platform_role: "555".into(),
        role: "trusted".into(),
    };
    c.set_mapping(&mapping).await.unwrap();
    let maps = c.mappings(&PlatformId::new("discord"), "g1").await.unwrap();
    assert_eq!(maps, std::slice::from_ref(&mapping));
    h.audited("role.map").await;
    let remove = RemoveMappingRequest {
        platform: PlatformId::new("discord"),
        guild: "g1".into(),
        platform_role: "555".into(),
    };
    c.remove_mapping(&remove).await.unwrap();
    assert_eq!(
        status_of(&c.remove_mapping(&remove).await.unwrap_err()),
        StatusCode::NOT_FOUND
    );
    let (status, _) = h.raw(reqwest::Method::GET, "/api/auth/mappings").await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "platform and guild required"
    );
    h.sup.stop_all().await;
}

#[tokio::test]
async fn extensions_and_mcp() {
    let h = harness().await;
    let c = &h.client;
    let list = c.extensions().await.unwrap();
    assert_eq!(list.len(), 1);
    let ext = &list[0];
    assert_eq!(
        (ext.id.as_str(), ext.name.as_str(), ext.version.as_str()),
        ("demo", "Demo", "0.2.1")
    );
    assert_eq!(ext.module.as_str(), "ext.demo");
    assert_eq!((ext.enabled, ext.state), (true, ModuleStateKind::Running));
    assert_eq!(ext.permissions, ["tools", "events:game.*"]);

    let ext = c.extension_action("demo", "disable").await.unwrap();
    assert_eq!((ext.enabled, ext.state), (false, ModuleStateKind::Disabled));
    let entry = h.audited("extension.disable").await;
    assert_eq!(entry.target, "ext.demo");
    let ext = c.extension_action("demo", "enable").await.unwrap();
    assert_eq!(ext.state, ModuleStateKind::Running);
    let err = c.extension_action("ghost", "enable").await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND);

    // Module actions are audited too, and `api` still refuses to stop itself.
    c.module_action("ext.demo", "restart").await.unwrap();
    h.audited("module.restart").await;
    let err = c.module_action("api", "disable").await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::CONFLICT);

    assert!(c.mcp_servers().await.unwrap().is_empty());
    let err = c.mcp_action("filesystem", "restart").await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn queue_listing_and_actions() {
    let h = harness().await;
    let c = &h.client;
    for (who, text) in [("1", "唱千本櫻"), ("2", "去挖鑽石"), ("3", "講笑話")] {
        h.queue
            .submit(SubmitRequest::new(
                account(who),
                format!("user{who}"),
                "song",
                text,
            ))
            .unwrap();
    }
    let state = c.queue().await.unwrap();
    assert!(!state.paused);
    let texts: Vec<&str> = state.items.iter().map(|i| i.text.as_str()).collect();
    assert_eq!(texts, ["唱千本櫻", "去挖鑽石", "講笑話"]);
    assert_eq!(
        state.items[0].author.as_ref().unwrap().display_name,
        "user1"
    );
    assert_eq!(state.items[0].kind, "song");

    let last = state.items[2].id.clone();
    let state = c.queue_move(&last, 0).await.unwrap();
    assert_eq!(state.items[0].text, "講笑話");
    h.audited("queue.move").await;

    let first = state.items[0].id.clone();
    let state = c.queue_skip(&first).await.unwrap();
    assert_eq!(state.items.len(), 2);
    let entry = h.audited("queue.skip").await;
    assert_eq!(entry.target, first);
    let err = c.queue_skip(&first).await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND, "already skipped");
    let err = c.queue_skip("nope").await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND);
    // Active items cannot be moved.
    let active = h.queue.next().unwrap();
    let err = c.queue_move(&active.id.to_string(), 1).await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::CONFLICT);

    assert!(c.queue_pause(true).await.unwrap().paused);
    assert!(h.queue.is_paused());
    h.audited("queue.pause").await;
    assert!(!c.queue_pause(false).await.unwrap().paused);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn stage_without_a_node() {
    let h = harness().await;
    h.sup
        .register(
            Arc::new(StageLinkModule::new()),
            json!({ "bind": "127.0.0.1:0", "token": "stage-token" }),
            true,
        )
        .await;
    h.sup
        .enable(&ModuleId::from(StageLinkModule::ID))
        .await
        .unwrap();
    let c = &h.client;
    let stage = c.stage().await.unwrap();
    assert!(!stage.vts.connected && !stage.obs.connected);
    assert_eq!(stage.node, None);
    assert!(stage.obs.error.unwrap().contains("not connected"));
    assert!(!stage.speaking);
    for err in [
        c.stage_scene("Gaming").await.unwrap_err(),
        c.stage_expression("blush").await.unwrap_err(),
        c.stage_stream(StreamAction::Start).await.unwrap_err(),
    ] {
        assert_eq!(status_of(&err), StatusCode::CONFLICT, "{err}");
    }
    h.sup.stop_all().await;
}

#[tokio::test]
async fn voice_monitor_and_say() {
    let mut h = harness().await;
    let c = &h.client;
    assert!(c.voice().await.unwrap().sessions.is_empty());
    let err = c.stage_say("哼", None).await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::CONFLICT, "not in voice yet");

    let voice = ModuleId::from("voice");
    h.bus.publish(
        &voice,
        Event::VoiceJoined {
            context: voice_context(),
            participants: vec![VoiceParticipant {
                account: account("5678"),
                display_name: "Mika".into(),
                is_self: false,
                muted: false,
                deafened: false,
            }],
        },
        None,
    );
    h.bus.publish(
        &voice,
        Event::Custom {
            topic: "voice.latency".into(),
            payload: json!({ "stage": "asr", "context": voice_context(), "asr_ms": 210 }),
        },
        None,
    );
    let mut state = c.voice().await.unwrap();
    for _ in 0..100 {
        if state
            .sessions
            .first()
            .is_some_and(|s| s.latency.asr.samples == 1)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        state = c.voice().await.unwrap();
    }
    let session = &state.sessions[0];
    assert_eq!(session.context, voice_context());
    assert_eq!(session.participants[0].display_name, "Mika");
    assert_eq!(session.latency.asr.p50_ms, Some(210));
    assert_eq!(session.latency.tts_first_audio.samples, 0);

    let said = c
        .stage_say("哼,才不是特地為你唱的。", Some("embarrassed"))
        .await
        .unwrap();
    let turn = said.turn.expect("a turn id");
    let (context, text, sink_turn) = tokio::time::timeout(Duration::from_secs(5), h.spoken.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(context, voice_context());
    assert_eq!(text, "哼,才不是特地為你唱的。");
    assert_eq!(sink_turn, Some(turn));
    h.audited("stage.say").await;
    let err = h.client.stage_say("   ", None).await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::BAD_REQUEST);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn serves_the_panel_without_a_token() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("assets")).unwrap();
    std::fs::write(
        dir.path().join("index.html"),
        "<!doctype html><title>Miyoria</title>",
    )
    .unwrap();
    std::fs::write(dir.path().join("assets/app-1a2b.js"), "console.log(1)").unwrap();
    std::fs::write(dir.path().join("favicon.svg"), "<svg/>").unwrap();
    let h = harness_with(json!({ "panel_dir": dir.path().to_string_lossy() })).await;
    let http = reqwest::Client::new();

    let index = http.get(format!("{}/", h.base)).send().await.unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    assert_eq!(index.headers()["cache-control"], "no-cache");
    assert!(
        index.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    assert!(index.text().await.unwrap().contains("Miyoria"));

    let asset = http
        .get(format!("{}/assets/app-1a2b.js", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(
        asset.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    let icon = http
        .get(format!("{}/favicon.svg", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(icon.headers()["cache-control"], "no-cache");

    let missing = http
        .get(format!("{}/nope.txt", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let escape = http
        .get(format!("{}/..%2F..%2FCargo.toml", h.base))
        .send()
        .await
        .unwrap();
    assert_ne!(escape.status(), StatusCode::OK);

    // The API keeps its JSON fallback and token check.
    let (status, body) = h.raw(reqwest::Method::GET, "/api/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "no such endpoint" }));
    let anon = http
        .get(format!("{}/api/queue", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
    h.sup.stop_all().await;
}
