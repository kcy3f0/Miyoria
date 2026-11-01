//! End-to-end tests: real module under a real supervisor, talking to the
//! fixture MCP server (a child process over stdio) and to Miyoria's own MCP
//! server over HTTP.

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use miyoria_kernel::{EventBus, Health, Module, ServiceRegistry, Supervisor};
use miyoria_mcp::{McpConfig, McpModule, McpStatus, ServerState};
use miyoria_tools::{ToolContext, ToolRegistry};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, MessageRef, ModuleId, PlatformId, Priority, TurnId,
};
use serde_json::{Value, json};

const FIXTURE: &str = env!("CARGO_BIN_EXE_miyoria-mcp-fixture");

struct Harness {
    sup: Supervisor,
    registry: Arc<ToolRegistry>,
    module: Arc<McpModule>,
}

impl Harness {
    async fn start(mcp: Value) -> Self {
        let services = Arc::new(ServiceRegistry::new());
        let app = ModuleId::from("app");
        let registry = Arc::new(ToolRegistry::new());
        services.provide(&app, registry.clone());
        let sup = Supervisor::new(EventBus::new(64), services.clone());
        services.provide(&app, Arc::new(sup.clone()));
        let module = Arc::new(McpModule::new(McpConfig::from_value(&mcp).unwrap()));
        sup.register(module.clone(), Value::Null, true).await;
        sup.start_all().await.unwrap();
        Self {
            sup,
            registry,
            module,
        }
    }

    fn status(&self) -> Arc<McpStatus> {
        self.module.status().expect("module running")
    }

    async fn call(&self, tool: &str, args: Value) -> anyhow::Result<String> {
        let tool = self
            .registry
            .get(tool)
            .unwrap_or_else(|| panic!("tool `{tool}` not registered"));
        tool.call(&tool_ctx(), args).await
    }

    async fn wait_connected(&self, server: &str) {
        let status = self.status();
        eventually(|| {
            let status = status.clone();
            let server = server.to_owned();
            async move { status.server(&server).is_some_and(|s| s.connected) }
        })
        .await;
    }
}

fn tool_ctx() -> ToolContext {
    let context = ContextKey {
        platform: PlatformId::new("test"),
        scope: None,
        channel: "c".into(),
        kind: ContextKind::Channel,
    };
    ToolContext {
        turn: TurnId::new(),
        context: context.clone(),
        account: AccountRef {
            platform: PlatformId::new("test"),
            id: "u".into(),
        },
        message: MessageRef {
            context,
            id: "m".into(),
        },
        priority: Priority::Direct,
    }
}

async fn eventually<F, Fut>(mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("condition not met within 20s");
}

fn fixture(extra: Value) -> Value {
    let mut server = json!({"transport": "stdio", "command": FIXTURE});
    server
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    server
}

fn fast_backoff(mut mcp: Value) -> Value {
    mcp["reconnect_initial_ms"] = json!(50);
    mcp["reconnect_max_ms"] = json!(200);
    mcp
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registers_allowed_tools_with_specs_and_permission() {
    let h = Harness::start(json!({"servers": {"fx": fixture(json!({
        "tools_deny": ["danger_*", "crash"],
    }))}}))
    .await;
    h.wait_connected("fx").await;

    let names = h.registry.names();
    for expected in [
        "mcp_fx_echo",
        "mcp_fx_big",
        "mcp_fx_dotted_name",
        "mcp_fx_read_a",
    ] {
        assert!(
            names.contains(&expected.to_owned()),
            "{expected} in {names:?}"
        );
    }
    assert!(!names.contains(&"mcp_fx_danger_delete".to_owned()));
    assert!(!names.contains(&"mcp_fx_crash".to_owned()));

    let echo = h.registry.get("mcp_fx_echo").unwrap();
    assert_eq!(echo.permission(), Some("tools.mcp.fx"));
    let spec = echo.spec();
    assert_eq!(spec.description, "Echoes `text`.");
    assert_eq!(spec.parameters["properties"]["text"]["type"], "string");

    let st = h.status().server("fx").unwrap();
    assert!(st.connected);
    assert_eq!(st.state, ServerState::Connected);
    assert_eq!(st.remote_tool_count, 12);
    assert_eq!(st.tools.len(), 10);
    assert_eq!(h.status().connected_count(), 1);
    assert_eq!(h.module.health().await, Health::Healthy);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn allow_list_and_permission_override() {
    let h = Harness::start(json!({"servers": {
        "a": fixture(json!({"tools_allow": ["echo", "read_*"], "permission": "tools.custom"})),
        "b": fixture(json!({"tools_allow": ["echo"], "permission": ""})),
    }}))
    .await;
    h.wait_connected("a").await;
    h.wait_connected("b").await;

    let mut names = h.registry.names();
    names.sort();
    assert_eq!(
        names,
        ["mcp_a_echo", "mcp_a_read_a", "mcp_b_echo"].map(String::from)
    );
    assert_eq!(
        h.registry.get("mcp_a_echo").unwrap().permission(),
        Some("tools.custom")
    );
    assert_eq!(h.registry.get("mcp_b_echo").unwrap().permission(), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn calls_flatten_results_and_pass_env_and_cwd() {
    let cwd = std::env::temp_dir().join("miyoria-mcp-test-cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let h = Harness::start(json!({"servers": {"fx": fixture(json!({
        "env": {"FIXTURE_VAR": "hello-env"},
        "cwd": cwd,
    }))}}))
    .await;
    h.wait_connected("fx").await;

    assert_eq!(
        h.call("mcp_fx_echo", json!({"text": "hi 你好"}))
            .await
            .unwrap(),
        "hi 你好"
    );
    let image = h.call("mcp_fx_image", json!({})).await.unwrap();
    assert!(image.starts_with("caption\n"), "{image}");
    assert!(image.contains("[image omitted: image/png]"), "{image}");
    assert_eq!(
        h.call("mcp_fx_env", json!({"name": "FIXTURE_VAR"}))
            .await
            .unwrap(),
        "hello-env"
    );
    let got = h.call("mcp_fx_cwd", json!({})).await.unwrap();
    assert!(got.ends_with("miyoria-mcp-test-cwd"), "{got}");

    let err = h.call("mcp_fx_fail", json!({})).await.unwrap_err();
    assert!(err.to_string().contains("it broke"), "{err}");
    let err = h
        .call("mcp_fx_echo", json!("not an object"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("JSON object"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn long_results_are_truncated() {
    let h =
        Harness::start(json!({"servers": {"fx": fixture(json!({"max_result_chars": 100}))}})).await;
    h.wait_connected("fx").await;
    let out = h.call("mcp_fx_big", json!({"n": 1000})).await.unwrap();
    assert!(out.starts_with(&"x".repeat(100)));
    assert!(out.ends_with("[truncated: 900 more characters]"), "{out}");
    assert_eq!(
        h.call("mcp_fx_big", json!({"n": 100})).await.unwrap().len(),
        100
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_calls_time_out_without_breaking_the_connection() {
    let h = Harness::start(json!({"servers": {"fx": fixture(json!({"timeout_ms": 300}))}})).await;
    h.wait_connected("fx").await;
    let started = Instant::now();
    let err = h
        .call("mcp_fx_slow", json!({"ms": 5000}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("timed out"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(
        h.call("mcp_fx_echo", json!({"text": "still ok"}))
            .await
            .unwrap(),
        "still ok"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failing_server_is_isolated() {
    let h = Harness::start(fast_backoff(json!({"servers": {
        "good": fixture(json!({})),
        "refuses": fixture(json!({"env": {"FIXTURE_EXIT_AT_START": "1"}})),
        "missing": {"transport": "stdio", "command": "definitely-not-a-real-command-xyz"},
        "invalid": {"transport": "http", "url": "not a url"},
        "off": fixture(json!({"enabled": false})),
    }})))
    .await;
    h.wait_connected("good").await;
    let status = h.status();

    eventually(|| {
        let status = status.clone();
        async move {
            ["refuses", "missing"]
                .iter()
                .all(|n| status.server(n).is_some_and(|s| s.last_error.is_some()))
        }
    })
    .await;
    for name in ["refuses", "missing", "invalid"] {
        let s = status.server(name).unwrap();
        assert!(!s.connected, "{name}");
        assert_eq!(s.state, ServerState::Failed, "{name}");
        assert!(s.tools.is_empty());
    }
    assert!(
        status
            .server("invalid")
            .unwrap()
            .last_error
            .unwrap()
            .contains("invalid config")
    );
    assert_eq!(status.server("off").unwrap().state, ServerState::Disabled);
    assert!(
        h.registry
            .names()
            .iter()
            .all(|n| n.starts_with("mcp_good_"))
    );
    assert_eq!(
        h.call("mcp_good_echo", json!({"text": "ok"}))
            .await
            .unwrap(),
        "ok"
    );
    assert!(matches!(h.module.health().await, Health::Degraded(r) if r.contains("refuses")));
    // The module itself stayed up.
    let listed = h.sup.list().await;
    assert_eq!(format!("{:?}", listed[0].state), "Running");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crashed_server_is_reconnected_and_others_keep_working() {
    let h = Harness::start(fast_backoff(json!({"servers": {
        "fx": fixture(json!({})),
        "other": fixture(json!({})),
    }})))
    .await;
    h.wait_connected("fx").await;
    h.wait_connected("other").await;

    let err = h.call("mcp_fx_crash", json!({})).await.unwrap_err();
    assert!(!err.to_string().is_empty());
    assert_eq!(
        h.call("mcp_other_echo", json!({"text": "alive"}))
            .await
            .unwrap(),
        "alive"
    );

    let status = h.status();
    eventually(|| {
        let status = status.clone();
        async move {
            status
                .server("fx")
                .is_some_and(|s| s.connected && s.reconnects >= 1)
        }
    })
    .await;
    assert_eq!(
        h.call("mcp_fx_echo", json!({"text": "back"}))
            .await
            .unwrap(),
        "back"
    );
    assert_eq!(status.server("other").unwrap().reconnects, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn follows_tool_list_changes() {
    let h = Harness::start(json!({"servers": {"fx": fixture(json!({}))}})).await;
    h.wait_connected("fx").await;
    assert!(h.registry.get("mcp_fx_extra").is_none());
    h.call("mcp_fx_grow", json!({})).await.unwrap();
    let registry = h.registry.clone();
    eventually(|| {
        let registry = registry.clone();
        async move { registry.get("mcp_fx_extra").is_some() }
    })
    .await;
    assert_eq!(
        h.call("mcp_fx_extra", json!({})).await.unwrap(),
        "called extra"
    );
    assert!(
        h.status()
            .server("fx")
            .unwrap()
            .tools
            .contains(&"mcp_fx_extra".to_owned())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_unregisters_everything() {
    let h = Harness::start(json!({"servers": {"fx": fixture(json!({}))}})).await;
    h.wait_connected("fx").await;
    assert!(!h.registry.is_empty());
    h.sup.stop_all().await;
    assert!(h.registry.is_empty(), "left: {:?}", h.registry.names());
}

/// Miyoria's own MCP server, used through the MCP client over HTTP.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exposed_server_round_trip_over_http() {
    let host = Harness::start(json!({"server": {
        "enabled": true, "bind": "127.0.0.1:0", "token": "s3cret"
    }}))
    .await;
    let addr = host.status().expose().listening.expect("listening");
    let url = format!("http://{addr}/mcp");

    let client = Harness::start(fast_backoff(json!({"servers": {
        "m": {"transport": "http", "url": url,
              "headers": {"Authorization": "Bearer s3cret"}},
        "wrong": {"transport": "http", "url": url,
                  "headers": {"Authorization": "Bearer nope"}},
    }})))
    .await;
    client.wait_connected("m").await;

    let mut names = client.registry.names();
    names.sort();
    assert_eq!(
        names,
        [
            "mcp_m_list_modules",
            "mcp_m_list_tools",
            "mcp_m_recent_decisions",
            "mcp_m_status"
        ]
        .map(String::from)
    );

    let modules = client.call("mcp_m_list_modules", json!({})).await.unwrap();
    let modules: Value = serde_json::from_str(&modules).unwrap();
    assert_eq!(modules[0]["id"], "mcp");
    assert_eq!(modules[0]["state"], "running");

    let status = client.call("mcp_m_status", json!({})).await.unwrap();
    assert!(status.contains("modules_total"), "{status}");

    // No decision log in this harness: reported as a tool error.
    let err = client
        .call("mcp_m_recent_decisions", json!({"limit": 5}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not available"), "{err}");

    // A wrong token never gets in: the attempt is reported as an error.
    let status = client.status();
    eventually(|| {
        let status = status.clone();
        async move {
            status
                .server("wrong")
                .is_some_and(|s| s.last_error.is_some())
        }
    })
    .await;
    assert!(!status.server("wrong").unwrap().connected);
    drop(host);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exposed_server_requires_a_token() {
    let h = Harness::start(json!({"server": {"enabled": true, "bind": "127.0.0.1:0"}})).await;
    let expose = h.status().expose();
    assert!(expose.listening.is_none());
    assert!(expose.error.unwrap().contains("token"));
    assert!(matches!(h.module.health().await, Health::Degraded(_)));
}
