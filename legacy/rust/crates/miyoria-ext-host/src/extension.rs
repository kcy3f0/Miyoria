//! One extension process managed as the supervisor module `ext.<id>`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::Context as _;
use async_trait::async_trait;
use miyoria_commands::{CommandRegistry, CommandSpec};
use miyoria_kernel::{Health, Module, ModuleContext, ModuleManifest, TopicFilter};
use miyoria_store::SettingsStore;
use miyoria_tools::{Tool, ToolRegistry, ToolSpec};
use miyoria_types::{Event, ModuleId, ProfileId, PromptContributors, TurnId};
use parking_lot::{Mutex, RwLock};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, trace, warn};

use crate::config::HostConfig;
use crate::manifest::{ExtensionManifest, Permissions, Runtime, valid_pattern, valid_topic};
use crate::protocol::{
    Contributions, ExtensionInfo, HostInfo, InitializeParams, InitializeResult, PROTOCOL_VERSION,
    ToolDecl, registry_tool_name, valid_tool_name,
};
use crate::proxy::{ProxyPrompt, ProxyTool, invoke_command};
use crate::rpc::{self, Handler, Peer, RpcError};

/// Topic prefixes of built-in events; extensions can never publish on them
/// (except a game adapter on its own `game.<id>.*`).
const RESERVED_PREFIXES: &[&str] = &["platform", "agent", "voice", "action", "system", "game"];

/// A discovered extension with the permissions the host grants it.
#[derive(Clone, Debug)]
pub struct ExtensionSpec {
    pub manifest: ExtensionManifest,
    /// Absolute extension directory.
    pub dir: PathBuf,
    pub granted: Permissions,
}

impl ExtensionSpec {
    pub fn module_id(&self) -> ModuleId {
        ModuleId::from(self.manifest.module_id())
    }
}

/// Supervisor module running one extension process. Started after `agent`
/// and `commands` when present; requires the `extensions` host module.
pub struct ExtensionModule {
    manifest: ModuleManifest,
    spec: Arc<ExtensionSpec>,
    host: Arc<HostConfig>,
    session: Mutex<Option<Arc<Session>>>,
}

struct Session {
    shared: Arc<Shared>,
    child: tokio::sync::Mutex<Child>,
}

#[derive(Default)]
struct Registrations {
    tools: BTreeMap<String, (Arc<ToolRegistry>, Arc<dyn Tool>)>,
    commands: BTreeMap<Vec<String>, (Arc<CommandRegistry>, CommandSpec)>,
    prompts: BTreeMap<String, Arc<PromptContributors>>,
}

struct Subscriptions {
    patterns: Vec<String>,
    filter: TopicFilter,
}

/// State shared by the module, its tasks and the RPC handler.
struct Shared {
    ctx: ModuleContext,
    spec: Arc<ExtensionSpec>,
    host: Arc<HostConfig>,
    peer: Arc<Peer>,
    grants: TopicFilter,
    subscriptions: RwLock<Subscriptions>,
    regs: Mutex<Registrations>,
    stopping: AtomicBool,
}

impl ExtensionModule {
    pub fn new(spec: ExtensionSpec, host: Arc<HostConfig>, schema: Option<Value>) -> Self {
        let m = &spec.manifest;
        let mut manifest = ModuleManifest::new(m.module_id(), m.display_name())
            .description(
                m.description
                    .clone()
                    .unwrap_or_else(|| format!("Extension {} {}", m.id, m.version)),
            )
            .requires(crate::host::ExtensionsModule::ID)
            .optional("agent")
            .optional("commands");
        manifest.config_schema = schema;
        Self {
            manifest,
            spec: Arc::new(spec),
            host,
            session: Mutex::new(None),
        }
    }

    pub fn spec(&self) -> &ExtensionSpec {
        &self.spec
    }

    fn command(&self) -> anyhow::Result<Command> {
        let m = &self.spec.manifest;
        let dir = &self.spec.dir;
        let entry = dir.join(&m.entry);
        let mut cmd = match m.runtime {
            Runtime::Node => {
                let mut c = Command::new(self.host.runtime_command("node"));
                c.arg(&entry);
                c
            }
            Runtime::Bun => {
                let mut c = Command::new(self.host.runtime_command("bun"));
                c.arg("run").arg(&entry);
                c
            }
            Runtime::Deno => {
                let mut c = Command::new(self.host.runtime_command("deno"));
                c.args(["run", "--allow-read", "--allow-env"]);
                if !self.spec.granted.network.is_empty() {
                    c.arg(format!(
                        "--allow-net={}",
                        self.spec.granted.network.join(",")
                    ));
                }
                c.arg(&entry);
                c
            }
            Runtime::Binary => Command::new(&entry),
        };
        cmd.current_dir(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("MIYORIA_RPC", "stdio")
            .env("MIYORIA_EXTENSION_ID", &m.id);
        Ok(cmd)
    }

    async fn handshake(&self, shared: &Shared) -> anyhow::Result<()> {
        let m = &self.spec.manifest;
        let params = InitializeParams {
            protocol: PROTOCOL_VERSION,
            host: HostInfo {
                name: "miyoria".to_owned(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
            },
            extension: ExtensionInfo {
                id: m.id.clone(),
                version: m.version.clone(),
                dir: self.spec.dir.display().to_string(),
                game: m.game_id().map(str::to_owned),
            },
            config: match shared.ctx.raw_config() {
                Value::Null => json!({}),
                other => other.clone(),
            },
            permissions: self.spec.granted.clone(),
        };
        let result = shared
            .peer
            .request(
                "initialize",
                serde_json::to_value(params)?,
                HostConfig::ms(self.host.init_timeout_ms),
            )
            .await
            .map_err(|e| anyhow::anyhow!("initialize failed: {}", e.message))?;
        let result: InitializeResult =
            serde_json::from_value(result).context("invalid initialize result")?;
        shared.apply(result.contributions)
    }

    async fn shutdown(&self, session: &Session, graceful: bool) {
        let shared = &session.shared;
        shared.stopping.store(true, Ordering::SeqCst);
        if graceful {
            let _ = tokio::time::timeout(
                Duration::from_millis(200),
                shared.peer.notify("shutdown", json!({})),
            )
            .await;
        }
        {
            let mut child = session.child.lock().await;
            let grace = if graceful {
                HostConfig::ms(self.host.shutdown_grace_ms)
            } else {
                Duration::ZERO
            };
            if tokio::time::timeout(grace, child.wait()).await.is_err() {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            }
        }
        shared.cleanup();
    }
}

#[async_trait]
impl Module for ExtensionModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let id = self.spec.manifest.id.clone();
        let mut child = self
            .command()?
            .spawn()
            .with_context(|| format!("spawning extension `{id}`"))?;
        let stdin = child.stdin.take().context("child stdin")?;
        let stdout = child.stdout.take().context("child stdout")?;
        let stderr = child.stderr.take().context("child stderr")?;

        let (peer, pump) = Peer::new(stdin);
        ctx.spawn("rpc-writer", async move {
            let _ = pump.await; // broken pipes surface as EOF on the reader
            Ok(())
        });
        let shared = Arc::new(Shared {
            ctx: ctx.clone(),
            spec: self.spec.clone(),
            host: self.host.clone(),
            peer,
            grants: TopicFilter::new(self.spec.granted.events.clone()),
            subscriptions: RwLock::new(Subscriptions {
                patterns: Vec::new(),
                filter: TopicFilter::new(Vec::<String>::new()),
            }),
            regs: Mutex::new(Registrations::default()),
            stopping: AtomicBool::new(false),
        });
        let session = Arc::new(Session {
            shared: shared.clone(),
            child: tokio::sync::Mutex::new(child),
        });
        *self.session.lock() = Some(session.clone());

        ctx.spawn("stderr", forward_stderr(stderr, id.clone()));
        {
            let session = session.clone();
            let cancel = ctx.cancellation().clone();
            ctx.spawn("rpc", async move {
                let shared = session.shared.clone();
                let handler: Arc<dyn Handler> = shared.clone();
                let served = tokio::select! {
                    r = shared.peer.serve(stdout, handler) => r,
                    () = cancel.cancelled() => return Ok(()),
                };
                if shared.stopping.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let status = {
                    let mut child = session.child.lock().await;
                    match tokio::time::timeout(Duration::from_secs(1), child.wait()).await {
                        Ok(Ok(status)) => status.to_string(),
                        Ok(Err(e)) => e.to_string(),
                        Err(_) => {
                            let _ = child.start_kill();
                            "closed its stdout".to_owned()
                        }
                    }
                };
                match served {
                    Ok(()) => anyhow::bail!("extension `{id}` exited ({status})"),
                    Err(e) => anyhow::bail!("extension `{id}` protocol error: {e} ({status})"),
                }
            });
        }
        ctx.spawn(
            "events",
            forward_events(shared.clone(), ctx.cancellation().clone()),
        );

        match self.handshake(&shared).await {
            Ok(()) => {
                info!(ext = %self.spec.manifest.id, "extension running");
                Ok(())
            }
            Err(e) => {
                self.session.lock().take();
                self.shutdown(&session, false).await;
                Err(e)
            }
        }
    }

    async fn stop(&self) -> anyhow::Result<()> {
        let session = self.session.lock().take();
        if let Some(session) = session {
            self.shutdown(&session, true).await;
        }
        Ok(())
    }

    async fn health(&self) -> Health {
        match &*self.session.lock() {
            Some(s) if !s.shared.peer.is_closed() => Health::Healthy,
            _ => Health::Unhealthy("extension process is not running".to_owned()),
        }
    }
}

async fn forward_stderr(stderr: impl AsyncRead + Unpin, id: String) -> anyhow::Result<()> {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        info!(target: "miyoria_ext", ext = %id, "{line}");
    }
    Ok(())
}

async fn forward_events(shared: Arc<Shared>, cancel: CancellationToken) -> anyhow::Result<()> {
    let mut sub = shared.ctx.subscribe(TopicFilter::all());
    let me = shared.ctx.id().clone();
    loop {
        let env = tokio::select! {
            env = sub.recv() => env,
            () = cancel.cancelled() => return Ok(()),
        };
        let Some(env) = env else { return Ok(()) };
        if env.source == me {
            continue;
        }
        let topic = env.topic();
        if !shared.grants.matches(topic) || !shared.subscriptions.read().filter.matches(topic) {
            continue;
        }
        let mut value = serde_json::to_value(&*env)?;
        value["topic"] = Value::String(topic.to_owned());
        if !shared.peer.try_notify("event", value) {
            warn!(ext = %shared.spec.manifest.id, %topic, "extension is not keeping up; event dropped");
        }
    }
}

impl Shared {
    fn id(&self) -> &str {
        &self.spec.manifest.id
    }

    fn timeout_call(&self) -> Duration {
        HostConfig::ms(self.host.call_timeout_ms)
    }

    /// Applies the contributions returned by `initialize`. Permission
    /// violations fail the start; a missing registry only warns.
    fn apply(&self, c: Contributions) -> anyhow::Result<()> {
        let fatal = |e: &RpcError| e.code != rpc::UNAVAILABLE;
        self.subscribe(&c.subscriptions)
            .map_err(|e| anyhow::anyhow!("subscriptions: {}", e.message))?;
        for decl in c.tools {
            let name = decl.name.clone();
            if let Err(e) = self.register_tool(decl) {
                if fatal(&e) {
                    anyhow::bail!("tool `{name}`: {}", e.message);
                }
                warn!(ext = %self.id(), tool = %name, error = %e.message, "tool not registered");
            }
        }
        for spec in c.commands {
            let name = spec.name();
            if let Err(e) = self.register_command(spec) {
                if fatal(&e) {
                    anyhow::bail!("command `{name}`: {}", e.message);
                }
                warn!(ext = %self.id(), command = %name, error = %e.message, "command not registered");
            }
        }
        for key in c.prompts {
            if let Err(e) = self.register_prompt(&key) {
                if fatal(&e) {
                    anyhow::bail!("prompt `{key}`: {}", e.message);
                }
                warn!(ext = %self.id(), prompt = %key, error = %e.message, "prompt not registered");
            }
        }
        Ok(())
    }

    fn subscribe(&self, topics: &[String]) -> Result<Value, RpcError> {
        if let Some(bad) = topics.iter().find(|t| !valid_pattern(t)) {
            return Err(RpcError::invalid_params(format!(
                "bad topic pattern `{bad}`"
            )));
        }
        let mut subs = self.subscriptions.write();
        for t in topics {
            if !subs.patterns.contains(t) {
                subs.patterns.push(t.clone());
            }
        }
        subs.filter = TopicFilter::new(subs.patterns.clone());
        Ok(json!({ "topics": subs.patterns }))
    }

    fn unsubscribe(&self, topics: &[String]) -> Value {
        let mut subs = self.subscriptions.write();
        subs.patterns.retain(|p| !topics.contains(p));
        subs.filter = TopicFilter::new(subs.patterns.clone());
        json!({ "topics": subs.patterns })
    }

    fn publish(&self, params: Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        struct Params {
            topic: String,
            #[serde(default)]
            payload: Value,
            #[serde(default)]
            correlation: Option<TurnId>,
        }
        let p: Params = serde_json::from_value(params).map_err(RpcError::invalid_params)?;
        if !valid_topic(&p.topic) {
            return Err(RpcError::invalid_params(format!("bad topic `{}`", p.topic)));
        }
        let own = format!("ext.{}.", self.id());
        let own_game = self
            .spec
            .manifest
            .game_id()
            .is_some_and(|g| p.topic.starts_with(&format!("game.{g}.")));
        let reserved = RESERVED_PREFIXES
            .iter()
            .any(|r| p.topic == *r || p.topic.starts_with(&format!("{r}.")));
        let allowed =
            p.topic.starts_with(&own) || own_game || (!reserved && self.grants.matches(&p.topic));
        if !allowed {
            return Err(RpcError::denied(format!(
                "publishing on `{}` is not permitted",
                p.topic
            )));
        }
        let event = Event::Custom {
            topic: p.topic,
            payload: p.payload,
        };
        match p.correlation {
            Some(turn) => self.ctx.publish_in_turn(event, turn),
            None => self.ctx.publish(event),
        }
        Ok(json!({}))
    }

    fn closed_error() -> RpcError {
        RpcError::new(rpc::CLOSED, "the extension is stopping")
    }

    fn register_tool(&self, decl: ToolDecl) -> Result<Value, RpcError> {
        if !self.spec.granted.tools {
            return Err(RpcError::denied("the `tools` permission is not granted"));
        }
        if !valid_tool_name(&decl.name) {
            return Err(RpcError::invalid_params(format!(
                "invalid tool name `{}`",
                decl.name
            )));
        }
        if !game_tool_allowed(&decl.name, self.spec.manifest.game_id()) {
            return Err(RpcError::denied(format!(
                "tool `{}` is in another game's namespace; only the adapter declaring that `game` may use `game.<id>.*`",
                decl.name
            )));
        }
        let registry =
            self.ctx.services().get::<ToolRegistry>().ok_or_else(|| {
                RpcError::new(rpc::UNAVAILABLE, "the tool registry is not available")
            })?;
        let name = registry_tool_name(&decl.name);
        let mut regs = self.regs.lock();
        if self.stopping.load(Ordering::SeqCst) {
            return Err(Self::closed_error());
        }
        if registry.get(&name).is_some() && !regs.tools.contains_key(&name) {
            return Err(RpcError::new(
                rpc::CONFLICT,
                format!("tool `{name}` is already registered"),
            ));
        }
        let tool: Arc<dyn Tool> = Arc::new(ProxyTool {
            peer: self.peer.clone(),
            wire_name: decl.name,
            spec: ToolSpec {
                name: name.clone(),
                description: decl.description,
                parameters: decl.parameters,
            },
            permission: decl.permission,
            timeout: self.timeout_call(),
        });
        registry
            .register(tool.clone())
            .map_err(RpcError::invalid_params)?;
        regs.tools.insert(name.clone(), (registry, tool));
        Ok(json!({ "name": name }))
    }

    fn unregister_tool(&self, wire: &str) -> Value {
        let name = registry_tool_name(wire);
        let removed = self.regs.lock().tools.remove(&name);
        if let Some((registry, tool)) = removed {
            unregister_tool_if_ours(&registry, &name, &tool);
        }
        json!({})
    }

    fn register_command(&self, spec: CommandSpec) -> Result<Value, RpcError> {
        if !self.spec.granted.commands {
            return Err(RpcError::denied("the `commands` permission is not granted"));
        }
        let registry = self
            .ctx
            .services()
            .get::<CommandRegistry>()
            .ok_or_else(|| {
                RpcError::new(rpc::UNAVAILABLE, "the command registry is not available")
            })?;
        let mut regs = self.regs.lock();
        if self.stopping.load(Ordering::SeqCst) {
            return Err(Self::closed_error());
        }
        if registry.get(&spec.path).is_some() && !regs.commands.contains_key(&spec.path) {
            return Err(RpcError::new(
                rpc::CONFLICT,
                format!("command `{}` is already registered", spec.name()),
            ));
        }
        let peer = self.peer.clone();
        let timeout = self.timeout_call();
        let handler_spec = spec.clone();
        registry
            .register(spec.clone(), move |inv| {
                invoke_command(peer.clone(), handler_spec.clone(), inv, timeout)
            })
            .map_err(RpcError::invalid_params)?;
        regs.commands.insert(spec.path.clone(), (registry, spec));
        Ok(json!({}))
    }

    fn unregister_command(&self, path: &[String]) -> Value {
        let removed = self.regs.lock().commands.remove(path);
        if let Some((registry, spec)) = removed {
            unregister_command_if_ours(&registry, &spec);
        }
        json!({})
    }

    fn prompt_key(&self, key: &str) -> String {
        format!("ext.{}.{key}", self.id())
    }

    fn register_prompt(&self, key: &str) -> Result<Value, RpcError> {
        if key.is_empty() || key.len() > 64 {
            return Err(RpcError::invalid_params("prompt key must be 1-64 chars"));
        }
        let registry = self
            .ctx
            .services()
            .get::<PromptContributors>()
            .ok_or_else(|| {
                RpcError::new(rpc::UNAVAILABLE, "prompt contributors are not available")
            })?;
        let full = self.prompt_key(key);
        let mut regs = self.regs.lock();
        if self.stopping.load(Ordering::SeqCst) {
            return Err(Self::closed_error());
        }
        registry.register(Arc::new(ProxyPrompt {
            peer: self.peer.clone(),
            key: full.clone(),
            wire_key: key.to_owned(),
            timeout: HostConfig::ms(self.host.prompt_timeout_ms),
        }));
        regs.prompts.insert(full.clone(), registry);
        Ok(json!({ "key": full }))
    }

    fn unregister_prompt(&self, key: &str) -> Value {
        let full = self.prompt_key(key);
        if let Some(registry) = self.regs.lock().prompts.remove(&full) {
            registry.unregister(&full);
        }
        json!({})
    }

    fn storage(&self) -> Result<(Arc<dyn SettingsStore>, ProfileId), RpcError> {
        let store = self
            .ctx
            .services()
            .get::<dyn SettingsStore>()
            .ok_or_else(|| RpcError::new(rpc::UNAVAILABLE, "storage is not available"))?;
        let profile = self
            .ctx
            .services()
            .get::<ProfileId>()
            .map(|p| (*p).clone())
            .unwrap_or_else(|| ProfileId::from("default"));
        Ok((store, profile))
    }

    fn storage_key(&self, key: &str) -> Result<String, RpcError> {
        if key.is_empty() || key.len() > 200 {
            return Err(RpcError::invalid_params("storage key must be 1-200 chars"));
        }
        Ok(format!("ext:{}:{key}", self.id()))
    }

    fn log(&self, params: Value) {
        #[derive(Deserialize)]
        struct Params {
            #[serde(default)]
            level: String,
            message: String,
            #[serde(default)]
            fields: Option<Value>,
        }
        let Ok(p) = serde_json::from_value::<Params>(params) else {
            return;
        };
        let id = self.id();
        let fields = p.fields.map(|f| f.to_string()).unwrap_or_default();
        let msg = &p.message;
        match p.level.as_str() {
            "error" => error!(target: "miyoria_ext", ext = %id, %fields, "{msg}"),
            "warn" => warn!(target: "miyoria_ext", ext = %id, %fields, "{msg}"),
            "debug" => debug!(target: "miyoria_ext", ext = %id, %fields, "{msg}"),
            "trace" => trace!(target: "miyoria_ext", ext = %id, %fields, "{msg}"),
            _ => info!(target: "miyoria_ext", ext = %id, %fields, "{msg}"),
        }
    }

    /// Removes everything this session registered. Idempotent.
    fn cleanup(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let regs = std::mem::take(&mut *self.regs.lock());
        for (name, (registry, tool)) in regs.tools {
            unregister_tool_if_ours(&registry, &name, &tool);
        }
        for (_, (registry, spec)) in regs.commands {
            unregister_command_if_ours(&registry, &spec);
        }
        for (key, registry) in regs.prompts {
            registry.unregister(&key);
        }
    }
}

/// Tools under `game.` (registry `game_`) are reserved for the adapter that
/// declared that game: `game.<id>.*` (or `game_<id>_*`) with `own` = `<id>`.
fn game_tool_allowed(wire: &str, own: Option<&str>) -> bool {
    let name = registry_tool_name(wire);
    let Some(rest) = name.strip_prefix("game_") else {
        return true;
    };
    own.is_some_and(|g| {
        rest.strip_prefix(&registry_tool_name(g))
            .is_some_and(|tail| tail.starts_with('_'))
    })
}

fn unregister_tool_if_ours(registry: &ToolRegistry, name: &str, ours: &Arc<dyn Tool>) {
    if registry
        .get(name)
        .is_some_and(|t| std::ptr::addr_eq(Arc::as_ptr(&t), Arc::as_ptr(ours)))
    {
        registry.unregister(name);
    }
}

fn unregister_command_if_ours(registry: &CommandRegistry, spec: &CommandSpec) {
    if registry.get(&spec.path).as_ref() == Some(spec) {
        registry.unregister(&spec.name());
    }
}

#[derive(Deserialize)]
struct Topics {
    topics: Vec<String>,
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

#[derive(Deserialize)]
struct Keyed {
    key: String,
}

#[derive(Deserialize)]
struct CommandPath {
    path: PathParam,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PathParam {
    Words(Vec<String>),
    Joined(String),
}

fn params<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(RpcError::invalid_params)
}

#[async_trait]
impl Handler for Shared {
    async fn request(&self, method: &str, p: Value) -> Result<Value, RpcError> {
        match method {
            "events.subscribe" => self.subscribe(&params::<Topics>(p)?.topics),
            "events.unsubscribe" => Ok(self.unsubscribe(&params::<Topics>(p)?.topics)),
            "events.publish" => self.publish(p),
            "tools.register" => self.register_tool(params(p)?),
            "tools.unregister" => Ok(self.unregister_tool(&params::<Named>(p)?.name)),
            "commands.register" => self.register_command(params(p)?),
            "commands.unregister" => {
                let path = match params::<CommandPath>(p)?.path {
                    PathParam::Words(w) => w,
                    PathParam::Joined(s) => s.split_whitespace().map(str::to_owned).collect(),
                };
                Ok(self.unregister_command(&path))
            }
            "prompt.register" => self.register_prompt(&params::<Keyed>(p)?.key),
            "prompt.unregister" => Ok(self.unregister_prompt(&params::<Keyed>(p)?.key)),
            "storage.get" => {
                let key = self.storage_key(&params::<Keyed>(p)?.key)?;
                let (store, profile) = self.storage()?;
                let value = store
                    .get(&profile, &key)
                    .await
                    .map_err(RpcError::internal)?;
                Ok(json!({ "value": value }))
            }
            "storage.set" => {
                #[derive(Deserialize)]
                struct Set {
                    key: String,
                    #[serde(default)]
                    value: Option<Value>,
                }
                let set: Set = params(p)?;
                let key = self.storage_key(&set.key)?;
                let (store, profile) = self.storage()?;
                let value = set.value.filter(|v| !v.is_null());
                store
                    .set(&profile, &key, value)
                    .await
                    .map_err(RpcError::internal)?;
                Ok(json!({}))
            }
            "log" => {
                self.log(p);
                Ok(json!({}))
            }
            _ => Err(RpcError::new(
                rpc::METHOD_NOT_FOUND,
                format!("unknown method `{method}`"),
            )),
        }
    }

    async fn notification(&self, method: &str, params: Value) {
        match method {
            "log" => self.log(params),
            _ => debug!(ext = %self.id(), %method, "ignored notification"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::game_tool_allowed;

    #[test]
    fn game_tool_namespace() {
        assert!(game_tool_allowed("weather.now", None));
        assert!(game_tool_allowed("gamer_tag", None));
        assert!(!game_tool_allowed("game.minecraft.act", None));
        assert!(!game_tool_allowed("game_minecraft_act", None));
        assert!(game_tool_allowed("game.minecraft.act", Some("minecraft")));
        assert!(game_tool_allowed(
            "game_minecraft_observe",
            Some("minecraft")
        ));
        assert!(!game_tool_allowed("game.minecraft2.act", Some("minecraft")));
        assert!(!game_tool_allowed("game.minecraft", Some("minecraft")));
        assert!(!game_tool_allowed("game.terraria.act", Some("minecraft")));
    }
}
