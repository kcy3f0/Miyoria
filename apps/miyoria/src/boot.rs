//! Wires config, store, profile and modules into a running core node.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use miyoria_agent::AgentModule;
use miyoria_api::ApiModule;
use miyoria_commands::CommandsModule;
use miyoria_discord::DiscordBotModule;
use miyoria_kernel::{
    Config, EventBus, Module, ModuleContext, ModuleManifest, ServiceRegistry, Supervisor,
    SupervisorHandle, TopicFilter,
};
use miyoria_llm::{LlmConfig, LlmModule, ModelRef};
use miyoria_llm_openai::OpenAiFactory;
use miyoria_profile::Profile;
use miyoria_scheduler::SchedulerModule;
use miyoria_store::{
    DecisionLog, DecisionRecord, LogEntry, PersonaOverrideStore, SettingsStore, Store,
};
use miyoria_types::{AccountRef, Event, ModuleId, ModuleStateKind, PlatformSinks, ProfileId};
use tracing::{info, warn};

use crate::cli_platform::CliPlatform;

const KERNEL: &str = "kernel";

/// Every module the core knows about, for `miyoria module list`.
const MODULES: &[&str] = &[
    LlmModule::ID,
    "scheduler",
    "agent",
    CommandsModule::ID,
    DiscordBotModule::ID,
    RecorderModule::ID,
    ApiModule::ID,
];

pub struct Options {
    /// Run the terminal chat platform with this display name.
    pub cli_chat_name: Option<String>,
    /// Connect the Discord bot.
    pub discord: bool,
    /// Serve the Admin API.
    pub api: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            cli_chat_name: None,
            discord: true,
            api: true,
        }
    }
}

pub struct Boot {
    supervisor: Supervisor,
    pub profile_display_name: String,
}

impl Boot {
    pub async fn run_until_ctrl_c(self) -> anyhow::Result<()> {
        self.supervisor.start_all().await?;
        for status in self.supervisor.list().await {
            if let Some(reason) = status.reason {
                warn!(module = %status.id, state = ?status.state, %reason, "module not running");
            }
        }
        tokio::signal::ctrl_c().await?;
        info!("shutting down");
        self.supervisor.stop_all().await;
        Ok(())
    }
}

pub fn database_url(config: &Config) -> String {
    config
        .section("core.database_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("memory://")
        .to_owned()
}

pub fn load_profile(config: &Config) -> anyhow::Result<Profile> {
    let dir = config
        .section("core.profiles_dir")
        .and_then(|v| v.as_str())
        .unwrap_or("profiles");
    let id = config
        .section("core.profile")
        .and_then(|v| v.as_str())
        .unwrap_or("deepseek-chan");
    Profile::load(dir, id).with_context(|| format!("loading profile `{id}` from `{dir}`"))
}

/// The `llm` module with the profile's `[llm.purposes]` applied over the
/// global ones.
pub fn llm_module(config: &Config, profile: &Profile) -> anyhow::Result<LlmModule> {
    let llm: LlmConfig = config.get("llm")?;
    let mut overrides = HashMap::new();
    for (purpose, chain) in &profile.manifest.llm.purposes {
        let refs = chain
            .iter()
            .map(|s| s.parse::<ModelRef>())
            .collect::<anyhow::Result<Vec<_>>>()
            .with_context(|| format!("profile `{}` purpose `{purpose}`", profile.id))?;
        overrides.insert(purpose.clone(), refs);
    }
    Ok(LlmModule::new(llm, vec![Box::new(OpenAiFactory)]).with_purpose_overrides(overrides))
}

pub fn configured_modules(config: &Config) -> Vec<(String, bool)> {
    MODULES
        .iter()
        .map(|id| ((*id).to_owned(), config.module(id).0))
        .collect()
}

pub async fn build(config: &Config, options: Options) -> anyhow::Result<Boot> {
    let bus = EventBus::default();
    let services = Arc::new(ServiceRegistry::new());
    let supervisor = Supervisor::new(bus.clone(), services.clone());
    let kernel = ModuleId::from(KERNEL);

    let url = database_url(config);
    let store = Arc::new(
        Store::from_url(&url)
            .await
            .context("connecting to the database")?,
    );
    services.provide(&kernel, Arc::new(PlatformSinks::new()));
    services.provide::<SupervisorHandle>(&kernel, Arc::new(supervisor.clone()));
    services.provide(&kernel, store.clone());
    services.provide::<dyn SettingsStore>(&kernel, store.settings.clone());
    services.provide::<dyn DecisionLog>(&kernel, store.decisions.clone());
    services.provide::<dyn PersonaOverrideStore>(&kernel, store.persona_overrides.clone());

    let mut profile = load_profile(config)?;
    for (key, body) in store.persona_overrides.current(&profile.id).await? {
        profile.set_section(&key, body);
    }
    let profile_display_name = profile.display_name().to_owned();
    let profile_id = profile.id.clone();
    services.provide(&kernel, Arc::new(profile_id.clone()));

    let mut modules: Vec<Arc<dyn Module>> = vec![
        Arc::new(llm_module(config, &profile)?),
        Arc::new(SchedulerModule::new()),
        Arc::new(AgentModule::new(profile)),
        Arc::new(CommandsModule::new()),
        Arc::new(RecorderModule::new(store.clone(), profile_id)),
    ];
    if options.discord {
        modules.push(Arc::new(DiscordBotModule::new()));
    }
    if options.api {
        modules.push(Arc::new(ApiModule::new()));
    }
    if let Some(name) = options.cli_chat_name {
        modules.push(Arc::new(CliPlatform::new(name, &profile_display_name)));
    }

    for module in modules {
        let id = module.manifest().id.clone();
        let (mut enabled, section) = config.module(id.as_str());
        // A module disabled at runtime (command / panel) stays disabled.
        if let Some(saved) = store.module_state.get(&id).await? {
            enabled = enabled && saved;
        }
        let token_missing = section
            .get("token")
            .and_then(|t| t.as_str())
            .is_none_or(str::is_empty);
        if token_missing && (id.as_str() == DiscordBotModule::ID || id.as_str() == ApiModule::ID) {
            warn!(module = %id, "token is empty; module disabled");
            enabled = false;
        }
        supervisor.register(module, section, enabled).await;
    }
    persist_module_state(&bus, store);

    Ok(Boot {
        supervisor,
        profile_display_name,
    })
}

/// Remembers runtime enable / disable so it survives restarts.
fn persist_module_state(bus: &EventBus, store: Arc<Store>) {
    let mut sub = bus.subscribe(TopicFilter::new(["system.module.state"]));
    tokio::spawn(async move {
        while let Some(env) = sub.recv().await {
            let Event::ModuleStateChanged { module, state, .. } = &env.event else {
                continue;
            };
            let enabled = match state {
                ModuleStateKind::Disabled => false,
                ModuleStateKind::Running => true,
                _ => continue,
            };
            if let Err(e) = store.module_state.set(module, enabled).await {
                warn!(%module, error = %e, "failed to persist module state");
            }
        }
    });
}

/// `recorder`: writes every message (hers included) to the message log, keeps
/// the people table up to date and stores the agent's decision traces.
struct RecorderModule {
    manifest: ModuleManifest,
    store: Arc<Store>,
    profile: ProfileId,
}

impl RecorderModule {
    const ID: &'static str = "recorder";

    fn new(store: Arc<Store>, profile: ProfileId) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Message recorder")
                .description("Persists conversations and the people she meets"),
            store,
            profile,
        }
    }
}

#[async_trait]
impl Module for RecorderModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let mut sub = ctx.subscribe(TopicFilter::new([
            "platform.ready",
            "platform.message.created",
            "agent.decision",
        ]));
        let store = self.store.clone();
        let profile = self.profile.clone();
        let cancel = ctx.cancellation().clone();
        ctx.spawn("record", async move {
            let mut own: HashSet<AccountRef> = HashSet::new();
            loop {
                let env = tokio::select! {
                    () = cancel.cancelled() => return Ok(()),
                    env = sub.recv() => match env { Some(e) => e, None => return Ok(()) },
                };
                match &env.event {
                    Event::PlatformReady { self_account, .. } => {
                        own.insert(self_account.clone());
                    }
                    Event::PlatformMessageCreated(msg) => {
                        let is_self = own.contains(&msg.author.account);
                        let mut entry = LogEntry::from_incoming(profile.clone(), msg, is_self);
                        entry.turn = env.correlation;
                        if let Err(e) = store.messages.append(&entry).await {
                            warn!(error = %e, "failed to record message");
                        }
                        if !is_self
                            && let Err(e) = store
                                .people
                                .upsert_account(&msg.author.account, &msg.author.display_name)
                                .await
                        {
                            warn!(error = %e, "failed to record person");
                        }
                    }
                    Event::AgentDecision(trace) => {
                        let record = DecisionRecord {
                            id: ulid::Ulid::new(),
                            profile: profile.clone(),
                            ts: env.ts,
                            trace: trace.clone(),
                        };
                        if let Err(e) = store.decisions.append(&record).await {
                            warn!(error = %e, "failed to record decision");
                        }
                    }
                    _ => {}
                }
            }
        });
        Ok(())
    }
}
