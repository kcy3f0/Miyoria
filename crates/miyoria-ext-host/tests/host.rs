//! End-to-end tests against real Node extension processes.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use miyoria_commands::{ArgValue, CommandRegistry, Invocation, Permissions};
use miyoria_ext_host::discover_in;
use miyoria_kernel::{
    Config, EventBus, ServiceRegistry, Supervisor, SupervisorHandle, TopicFilter,
};
use miyoria_store::{SettingsStore, Store};
use miyoria_tools::{ToolContext, ToolRegistry};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, Event, MessageRef, ModuleId, ModuleStateKind, PlatformId,
    Priority, PromptContributors, PromptRequest, TurnId,
};
use serde_json::json;

const EXT: &str = "ext.test.fixture";

struct Harness {
    sup: Supervisor,
    bus: EventBus,
    tools: Arc<ToolRegistry>,
    commands: Arc<CommandRegistry>,
    prompts: Arc<PromptContributors>,
}

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn toml_path(p: &Path) -> String {
    format!("{:?}", p.display().to_string())
}

/// Starts a supervisor with the given extension dirs. `None` when Node is
/// not installed.
async fn harness(dirs: &[PathBuf], extra: &str) -> Option<Harness> {
    if !node_available() {
        eprintln!("skipping: `node` is not on PATH");
        return None;
    }
    let dirs: Vec<String> = dirs.iter().map(|d| toml_path(d)).collect();
    let init = if extra.contains("init_timeout_ms") {
        ""
    } else {
        "init_timeout_ms = 5000\n"
    };
    let config = Config::from_toml_str(&format!(
        "[modules.extensions]\ndirs = [{}]\n{init}call_timeout_ms = 400\nshutdown_grace_ms = 500\n{extra}",
        dirs.join(", ")
    ))
    .unwrap();
    let bus = EventBus::default();
    let services = Arc::new(ServiceRegistry::new());
    let sup = Supervisor::new(bus.clone(), services.clone());
    let app = ModuleId::from("app");
    let tools = Arc::new(ToolRegistry::new());
    let commands = Arc::new(CommandRegistry::new(
        Permissions::from_strings::<&str>(&[]).unwrap(),
    ));
    let prompts = Arc::new(PromptContributors::new());
    services.provide(&app, tools.clone());
    services.provide(&app, commands.clone());
    services.provide(&app, prompts.clone());
    services.provide::<dyn SettingsStore>(&app, Store::memory().settings);
    services.provide::<SupervisorHandle>(&app, Arc::new(sup.clone()));

    let discovery = discover_in(&config, &fixtures()).unwrap();
    for m in discovery.modules {
        sup.register(m.module, m.config, m.enabled).await;
    }
    sup.start_all().await.unwrap();
    Some(Harness {
        sup,
        bus,
        tools,
        commands,
        prompts,
    })
}

impl Harness {
    async fn status(&self, id: &str) -> (ModuleStateKind, Option<String>) {
        let s = self
            .sup
            .list()
            .await
            .into_iter()
            .find(|s| s.id.as_str() == id)
            .unwrap_or_else(|| panic!("module {id} not registered"));
        (s.state, s.reason)
    }

    async fn wait_state(
        &self,
        id: &str,
        want: ModuleStateKind,
        within: Duration,
    ) -> Option<String> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let (state, reason) = self.status(id).await;
            if state == want {
                return reason;
            }
            if tokio::time::Instant::now() > deadline {
                panic!("{id} is {state:?} ({reason:?}), wanted {want:?}");
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn call(&self, tool: &str, args: serde_json::Value) -> anyhow::Result<String> {
        let tool = self
            .tools
            .get(tool)
            .unwrap_or_else(|| panic!("tool {tool} missing"));
        tool.call(&tool_ctx(), args).await
    }
}

fn context() -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: None,
        channel: "c1".into(),
        kind: ContextKind::Dm,
    }
}

fn account() -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: "42".into(),
    }
}

fn tool_ctx() -> ToolContext {
    ToolContext {
        turn: TurnId::new(),
        context: context(),
        account: account(),
        message: MessageRef {
            context: context(),
            id: "m1".into(),
        },
        priority: Priority::Direct,
    }
}

fn invocation(path: &str, args: &[(&str, &str)]) -> Invocation {
    let mut inv = Invocation::new(path, account(), context());
    inv.invoker_display_name = "Owen".into();
    for (k, v) in args {
        inv = inv.with_arg(*k, ArgValue::String((*v).to_owned()));
    }
    inv
}

fn custom(topic: &str) -> Event {
    Event::Custom {
        topic: topic.to_owned(),
        payload: json!({}),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_and_round_trips() {
    let Some(h) = harness(&[fixtures().join("test-ext")], "").await else {
        return;
    };
    h.wait_state(EXT, ModuleStateKind::Running, Duration::from_secs(5))
        .await;
    assert_eq!(
        h.tools.names(),
        [
            "crash_now",
            "echo_say",
            "slow_wait",
            "store_roundtrip",
            "try_publish"
        ]
    );
    assert_eq!(
        h.tools.get("echo_say").unwrap().spec().parameters["type"],
        "object"
    );

    // Tool call round trip, with the tool context forwarded.
    let out = h.call("echo_say", json!({ "text": "hi" })).await.unwrap();
    assert_eq!(out, "echo: hi from 42");

    // Command invoke.
    let reply = h
        .commands
        .dispatch(invocation("fixture echo", &[("text", "yo")]))
        .await
        .unwrap();
    assert_eq!(reply.text, "fixture: yo by Owen");
    assert!(reply.ephemeral);

    // Prompt contribution, namespaced by extension id.
    let contributor = h
        .prompts
        .all()
        .into_iter()
        .find(|c| c.key() == "ext.test.fixture.facts")
        .expect("prompt contributor registered");
    let sections = contributor
        .contribute(&PromptRequest {
            profile: "p".into(),
            turn: TurnId::new(),
            context: context(),
            participants: vec![],
            speakers: vec![],
            query: "你好".into(),
            recent: vec![],
            voice: false,
            now: chrono::Utc::now(),
        })
        .await
        .unwrap();
    assert_eq!(sections[0].body, "query=你好");
    assert_eq!(sections[0].key, "facts");

    // Per-extension storage.
    let stored = h
        .call(
            "store_roundtrip",
            json!({ "key": "k", "value": { "n": 1 } }),
        )
        .await
        .unwrap();
    assert_eq!(stored, r#"{"n":1}"#);

    // Disabling the module removes every proxy.
    h.sup.disable(&EXT.into()).await.unwrap();
    assert!(h.tools.is_empty());
    assert!(h.commands.specs().is_empty());
    assert!(h.prompts.all().is_empty());
    h.sup.stop_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn events_are_filtered_by_permissions() {
    let Some(h) = harness(&[fixtures().join("test-ext")], "").await else {
        return;
    };
    h.wait_state(EXT, ModuleStateKind::Running, Duration::from_secs(5))
        .await;
    let mut seen = h.bus.subscribe(TopicFilter::new(["ext.test.fixture.seen"]));
    let src = ModuleId::from("test");
    // Granted: custom.ok.*, ext.other.*
    for topic in [
        "custom.ok.a",
        "custom.no.b",
        "ext.other.x",
        "ext.otherx.y",
        "custom.ok.c",
    ] {
        h.bus.publish(&src, custom(topic), None);
    }
    let mut topics = Vec::new();
    while topics.len() < 3 {
        let env = tokio::time::timeout(Duration::from_secs(3), seen.recv())
            .await
            .expect("extension echoed the event")
            .unwrap();
        let Event::Custom { payload, .. } = &env.event else {
            panic!("unexpected event");
        };
        assert_eq!(env.source.as_str(), EXT);
        topics.push(payload["topic"].as_str().unwrap().to_owned());
    }
    topics.sort();
    assert_eq!(topics, ["custom.ok.a", "custom.ok.c", "ext.other.x"]);
    assert!(
        tokio::time::timeout(Duration::from_millis(200), seen.recv())
            .await
            .is_err(),
        "no event outside the granted patterns"
    );

    // Publishing permissions.
    let publish = async |topic: &str| {
        h.call("try_publish", json!({ "topic": topic }))
            .await
            .unwrap()
    };
    assert_eq!(publish("custom.ok.z").await, "ok");
    assert_eq!(publish("ext.test.fixture.mine").await, "ok");
    assert_eq!(publish("custom.no.z").await, "denied: -32001");
    assert_eq!(publish("platform.message.created").await, "denied: -32001");
    h.sup.stop_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_fails_module_then_restarts() {
    let Some(h) = harness(&[fixtures().join("test-ext")], "").await else {
        return;
    };
    h.wait_state(EXT, ModuleStateKind::Running, Duration::from_secs(5))
        .await;
    assert_eq!(h.call("crash_now", json!({})).await.unwrap(), "bye");
    let reason = h
        .wait_state(EXT, ModuleStateKind::Failed, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(reason.contains("exited"), "{reason}");
    assert!(
        h.tools.get("echo_say").is_none(),
        "proxies removed on crash"
    );

    // Supervisor backoff (2 s for the first failure) brings it back.
    h.wait_state(EXT, ModuleStateKind::Running, Duration::from_secs(8))
        .await;
    let out = h
        .call("echo_say", json!({ "text": "again" }))
        .await
        .unwrap();
    assert_eq!(out, "echo: again from 42");
    h.sup.stop_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_time_out() {
    let Some(h) = harness(&[fixtures().join("test-ext")], "").await else {
        return;
    };
    h.wait_state(EXT, ModuleStateKind::Running, Duration::from_secs(5))
        .await;
    let started = std::time::Instant::now();
    let err = h.call("slow_wait", json!({})).await.unwrap_err();
    assert!(err.to_string().contains("timed out"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(2));
    // The connection is still usable afterwards.
    assert!(h.call("echo_say", json!({ "text": "x" })).await.is_ok());
    h.sup.stop_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initialize_times_out() {
    let extra = "init_timeout_ms = 300\n[extensions.\"test.fixture\"]\nhang_init = true";
    let Some(h) = harness(&[fixtures().join("test-ext")], extra).await else {
        return;
    };
    let reason = h
        .wait_state(EXT, ModuleStateKind::Failed, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(
        reason.contains("initialize") && reason.contains("timed out"),
        "{reason}"
    );
    assert!(h.tools.is_empty());
    h.sup.stop_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undeclared_permissions_are_rejected() {
    // Static contributions with tools but no `tools` permission: start fails.
    let Some(h) = harness(&[fixtures().join("no-perms")], "").await else {
        return;
    };
    let reason = h
        .wait_state(
            "ext.test.noperms",
            ModuleStateKind::Failed,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(reason.contains("`tools` permission"), "{reason}");
    assert!(h.tools.is_empty() && h.commands.specs().is_empty());
    h.sup.stop_all().await;

    // Dynamic registration is refused with PERMISSION_DENIED.
    let extra = "[extensions.\"test.noperms\"]\ndynamic = true";
    let Some(h) = harness(&[fixtures().join("no-perms")], extra).await else {
        return;
    };
    let mut results = h
        .bus
        .subscribe(TopicFilter::new(["ext.test.noperms.register_result"]));
    h.wait_state(
        "ext.test.noperms",
        ModuleStateKind::Running,
        Duration::from_secs(5),
    )
    .await;
    let env = tokio::time::timeout(Duration::from_secs(3), results.recv())
        .await
        .unwrap()
        .unwrap();
    let Event::Custom { payload, .. } = &env.event else {
        panic!("unexpected event");
    };
    assert_eq!(payload["ok"], false);
    assert_eq!(payload["code"], -32001);
    assert!(h.tools.is_empty());
    h.sup.stop_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn discovery_skips_stage_extensions_and_honours_enabled() {
    let config = Config::from_toml_str(&format!(
        "[modules.extensions]\ndirs = [{}]\n[extensions.\"test.noperms\"]\nenabled = false",
        toml_path(&fixtures())
    ))
    .unwrap();
    let d = discover_in(&config, Path::new(".")).unwrap();
    let ids: Vec<(String, bool)> = d
        .modules
        .iter()
        .map(|m| (m.module.manifest().id.to_string(), m.enabled))
        .collect();
    assert_eq!(
        ids,
        [
            ("extensions".to_owned(), true),
            ("ext.test.noperms".to_owned(), false),
            ("ext.test.fixture".to_owned(), true),
        ]
    );
    assert_eq!(d.skipped.len(), 1);
    assert!(d.skipped[0].1.contains("stage"));
    let ext = d.modules[2].module.manifest();
    assert_eq!(ext.requires, [ModuleId::from("extensions")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dev_mode_restarts_on_file_change() {
    let dir = std::env::temp_dir().join(format!("miyoria-dev-{}", ulid::Ulid::new()));
    let ext_dir = dir.join("test-ext");
    std::fs::create_dir_all(&ext_dir).unwrap();
    for f in ["index.mjs", "miyoria.extension.toml"] {
        std::fs::copy(fixtures().join("test-ext").join(f), ext_dir.join(f)).unwrap();
    }
    let Some(h) = harness(
        std::slice::from_ref(&dir),
        "dev = true\nwatch_poll_ms = 100",
    )
    .await
    else {
        return;
    };
    h.wait_state(EXT, ModuleStateKind::Running, Duration::from_secs(5))
        .await;
    let mut states = h.bus.subscribe(TopicFilter::new(["system.module.state"]));
    let script = ext_dir.join("index.mjs");
    let mut text = std::fs::read_to_string(&script).unwrap();
    text.push_str("\n// touched\n");
    std::fs::write(&script, text).unwrap();

    let mut saw_stopping = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let env = tokio::time::timeout_at(deadline, states.recv())
            .await
            .expect("restart after file change")
            .unwrap();
        if let Event::ModuleStateChanged { module, state, .. } = &env.event {
            if module.as_str() != EXT {
                continue;
            }
            match state {
                ModuleStateKind::Stopping => saw_stopping = true,
                ModuleStateKind::Running if saw_stopping => break,
                _ => {}
            }
        }
    }
    assert!(h.call("echo_say", json!({ "text": "dev" })).await.is_ok());
    h.sup.stop_all().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// Runs the SDK example when it has been built (`pnpm build` in
/// `packages/sdk` and `extensions/examples/hello`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sdk_hello_example() {
    let hello = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions/examples/hello");
    if !hello.join("dist/index.js").is_file() {
        eprintln!("skipping: extensions/examples/hello is not built");
        return;
    }
    let Some(h) = harness(&[hello], "").await else {
        return;
    };
    h.wait_state(
        "ext.miyoria.hello",
        ModuleStateKind::Running,
        Duration::from_secs(10),
    )
    .await;
    let out = h
        .call("dice", json!({ "sides": 6, "count": 3 }))
        .await
        .unwrap();
    assert!(out.contains("骰"), "{out}");
    let reply = h.commands.dispatch(invocation("hello", &[])).await.unwrap();
    assert!(reply.text.contains("Owen"), "{}", reply.text);
    h.sup.stop_all().await;
}
