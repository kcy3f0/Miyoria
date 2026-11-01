//! End-to-end tests: a real supervisor running the `api` module on a random
//! port, an in-memory store and a persona loaded from a temp profile dir,
//! driven through [`ApiClient`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use futures::StreamExt;
use miyoria_agent::PersonaHandle;
use miyoria_api::{ApiClient, ApiModule};
use miyoria_kernel::{
    EventBus, Module, ModuleContext, ModuleManifest, ServiceRegistry, Supervisor, SupervisorHandle,
};
use miyoria_llm::LlmRouter;
use miyoria_profile::Profile;
use miyoria_store::{DecisionLog, DecisionRecord, PersonaOverrideStore, Store};
use miyoria_types::{
    ContextKey, ContextKind, DecisionTrace, Event, ModuleId, ModuleStateKind, PlatformId,
    ProfileId, TurnId,
};
use reqwest::StatusCode;
use serde_json::json;
use ulid::Ulid;

const TOKEN: &str = "test-token";
const PROFILE: &str = "test-chan";

/// A module that just idles until stopped.
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

struct Harness {
    sup: Supervisor,
    services: Arc<ServiceRegistry>,
    store: Store,
    persona: PersonaHandle,
    client: ApiClient,
    base: String,
    _dir: tempfile::TempDir,
}

fn write_profile(dir: &std::path::Path) -> Profile {
    let root = dir.join(PROFILE);
    std::fs::create_dir_all(root.join("persona")).unwrap();
    std::fs::write(
        root.join("profile.toml"),
        format!("id = \"{PROFILE}\"\ndisplay_name = \"Test\"\n"),
    )
    .unwrap();
    std::fs::write(root.join("persona/identity.md"), "I am Test.\n").unwrap();
    std::fs::write(root.join("persona/style.md"), "Be brief.\n").unwrap();
    Profile::load(dir, PROFILE).unwrap()
}

async fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let persona = PersonaHandle::new(write_profile(dir.path()));

    let services = Arc::new(ServiceRegistry::new());
    let sup = Supervisor::new(EventBus::default(), services.clone());
    let kernel = ModuleId::from("kernel");
    let store = Store::memory();
    services.provide::<SupervisorHandle>(&kernel, Arc::new(sup.clone()));
    services.provide::<dyn DecisionLog>(&kernel, store.decisions.clone());
    services.provide::<dyn PersonaOverrideStore>(&kernel, store.persona_overrides.clone());
    services.provide(&kernel, Arc::new(ProfileId::from(PROFILE)));
    services.provide(&kernel, Arc::new(persona.clone()));
    services.provide(
        &ModuleId::from("llm"),
        Arc::new(LlmRouter::new(HashMap::new(), HashMap::new())),
    );

    let api = Arc::new(ApiModule::new());
    sup.register(
        api.clone(),
        json!({ "bind": "127.0.0.1:0", "token": TOKEN }),
        true,
    )
    .await;
    sup.register(
        Arc::new(Idle(ModuleManifest::new("dummy", "Dummy"))),
        serde_json::Value::Null,
        true,
    )
    .await;
    sup.start_all().await.unwrap();

    let base = format!("http://{}", api.local_addr().expect("api is running"));
    let client = ApiClient::new(&base, TOKEN).unwrap();
    Harness {
        sup,
        services,
        store,
        persona,
        client,
        base,
        _dir: dir,
    }
}

fn status_of(err: &miyoria_api::ClientError) -> StatusCode {
    err.status()
        .unwrap_or_else(|| panic!("expected an API error, got {err}"))
}

#[tokio::test]
async fn health_and_auth() {
    let h = harness().await;
    let anon = ApiClient::new(&h.base, "wrong").unwrap();

    let health = anon.health().await.unwrap();
    assert_eq!(health.status, "ok");
    assert_eq!(health.version, env!("CARGO_PKG_VERSION"));

    let err = anon.modules().await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::UNAUTHORIZED);

    let raw = reqwest::get(format!("{}/api/modules", h.base))
        .await
        .unwrap();
    assert_eq!(raw.status(), StatusCode::UNAUTHORIZED);
    let body: serde_json::Value = raw.json().await.unwrap();
    assert!(body["error"].as_str().unwrap().contains("token"));

    let raw = reqwest::get(format!("{}/api/nope", h.base)).await.unwrap();
    assert_eq!(raw.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value = raw.json().await.unwrap();
    assert!(body["error"].is_string());

    h.sup.stop_all().await;
}

#[tokio::test]
async fn module_lifecycle() {
    let h = harness().await;
    let c = &h.client;

    let modules = c.modules().await.unwrap();
    let ids: Vec<&str> = modules.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["api", "dummy"]);
    assert!(modules.iter().all(|m| m.state == ModuleStateKind::Running));

    let m = c.module_action("dummy", "disable").await.unwrap();
    assert_eq!((m.enabled, m.state), (false, ModuleStateKind::Disabled));
    let err = c.module_action("dummy", "restart").await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::CONFLICT);
    let m = c.module_action("dummy", "enable").await.unwrap();
    assert_eq!((m.enabled, m.state), (true, ModuleStateKind::Running));
    let m = c.module_action("dummy", "restart").await.unwrap();
    assert_eq!(m.state, ModuleStateKind::Running);

    for action in ["disable", "restart"] {
        let err = c.module_action("api", action).await.unwrap_err();
        assert_eq!(status_of(&err), StatusCode::CONFLICT, "{action} api");
    }
    let err = c.module_action("ghost", "enable").await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND);
    let err = c.module_action("dummy", "explode").await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::NOT_FOUND);

    // Still serving after all of that.
    assert_eq!(c.modules().await.unwrap().len(), 2);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn persona_edit_and_history() {
    let h = harness().await;
    let c = &h.client;

    let sections = c.persona().await.unwrap();
    let pairs: Vec<(&str, &str)> = sections
        .iter()
        .map(|s| (s.key.as_str(), s.body.as_str()))
        .collect();
    assert_eq!(pairs, [("identity", "I am Test."), ("style", "Be brief.")]);

    assert_eq!(c.set_persona("style", "Be very brief.").await.unwrap(), 1);
    assert_eq!(
        c.set_persona_as("style", "Be terse.", Some("panel:owen"))
            .await
            .unwrap(),
        2
    );
    assert!(h.persona.persona_prompt().contains("Be terse."));
    let style = c
        .persona()
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.key == "style")
        .unwrap();
    assert_eq!(style.body, "Be terse.");

    let history = c.persona_history("style").await.unwrap();
    let editors: Vec<(u32, &str)> = history
        .iter()
        .map(|o| (o.version, o.edited_by.as_str()))
        .collect();
    assert_eq!(editors, [(1, "api"), (2, "panel:owen")]);
    let current = h
        .store
        .persona_overrides
        .current(&ProfileId::from(PROFILE))
        .await
        .unwrap();
    assert_eq!(current["style"], "Be terse.");

    let err = c.set_persona("bad key", "x").await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::BAD_REQUEST);
    h.sup.stop_all().await;
}

fn context(channel: &str) -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some("guild".into()),
        channel: channel.into(),
        kind: ContextKind::Channel,
    }
}

#[tokio::test]
async fn decisions_newest_first() {
    let h = harness().await;
    for (i, channel) in ["a", "b", "a"].into_iter().enumerate() {
        let record = DecisionRecord {
            id: Ulid::new(),
            profile: ProfileId::from(PROFILE),
            ts: Utc.timestamp_opt(1_700_000_000 + i as i64, 0).unwrap(),
            trace: DecisionTrace {
                turn: TurnId::new(),
                context: context(channel),
                respond: i % 2 == 0,
                score: i as f32,
                reasons: vec![format!("#{i}")],
            },
        };
        h.store.decisions.append(&record).await.unwrap();
    }

    let all = h.client.decisions(50).await.unwrap();
    let reasons: Vec<&str> = all.iter().map(|d| d.trace.reasons[0].as_str()).collect();
    assert_eq!(reasons, ["#2", "#1", "#0"]);
    assert_eq!(h.client.decisions(1).await.unwrap().len(), 1);

    let in_a = h
        .client
        .decisions_in(Some(&context("a")), 50)
        .await
        .unwrap();
    assert_eq!(in_a.len(), 2);
    assert!(in_a.iter().all(|d| d.trace.context.channel == "a"));

    let raw = reqwest::Client::new()
        .get(format!("{}/api/decisions?context=nope", h.base))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(raw.status(), StatusCode::BAD_REQUEST);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn usage_and_missing_service() {
    let h = harness().await;
    assert!(h.client.usage().await.unwrap().is_empty());

    h.services.remove_owned_by(&ModuleId::from("llm"));
    let err = h.client.usage().await.unwrap_err();
    assert_eq!(status_of(&err), StatusCode::SERVICE_UNAVAILABLE);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn events_stream_until_stop() {
    let h = harness().await;
    let mut events = h.client.events(["system.*"]).await.unwrap();

    h.client.module_action("dummy", "disable").await.unwrap();
    let env = tokio::time::timeout(Duration::from_secs(5), events.next())
        .await
        .expect("an event arrives")
        .expect("stream open")
        .unwrap();
    assert!(matches!(
        env.event,
        Event::ModuleStateChanged { ref module, .. } if module.as_str() == "dummy"
    ));

    // Stopping the module ends the stream (and lets the server shut down).
    h.sup.stop_all().await;
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(item) = events.next().await {
            item.unwrap();
        }
    })
    .await;
    assert!(ended.is_ok(), "event stream did not end on stop");
}

async fn wait_failed(sup: &Supervisor) -> String {
    for _ in 0..100 {
        let api = sup
            .list()
            .await
            .into_iter()
            .find(|m| m.id.as_str() == ApiModule::ID)
            .unwrap();
        if api.state == ModuleStateKind::Failed {
            return api.reason.unwrap_or_default();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("api module did not fail");
}

#[tokio::test]
async fn start_failures() {
    let sup = Supervisor::new(EventBus::default(), Arc::new(ServiceRegistry::new()));
    sup.register(Arc::new(ApiModule::new()), json!({ "token": "" }), true)
        .await;
    sup.start_all().await.unwrap();
    assert!(wait_failed(&sup).await.contains("MIYORIA_API_TOKEN"));

    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = taken.local_addr().unwrap();
    let sup = Supervisor::new(EventBus::default(), Arc::new(ServiceRegistry::new()));
    sup.register(
        Arc::new(ApiModule::new()),
        json!({ "bind": addr.to_string(), "token": TOKEN }),
        true,
    )
    .await;
    sup.start_all().await.unwrap();
    assert!(wait_failed(&sup).await.contains("cannot bind"));
}
