//! Wires config, store, profile and modules into a running core node.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use miyoria_agent::AgentModule;
use miyoria_api::ApiModule;
use miyoria_auth::AuthModule;
use miyoria_commands::CommandsModule;
use miyoria_discord::DiscordBotModule;
use miyoria_initiative::InitiativeModule;
use miyoria_kernel::{
    Config, EventBus, Module, ModuleContext, ModuleManifest, ServiceRegistry, Supervisor,
    SupervisorHandle, TopicFilter,
};
use miyoria_llm::{LlmConfig, LlmModule, ModelRef};
use miyoria_llm_openai::OpenAiFactory;
use miyoria_mcp::McpModule;
use miyoria_memory::{EmbeddingConfig, MemoryModule};
use miyoria_profile::Profile;
use miyoria_queue::QueueModule;
use miyoria_scheduler::SchedulerModule;
use miyoria_social::{MoodModule, SocialModule};
use miyoria_speech::{SpeechConfig, SpeechModule};
use miyoria_stage::StageLinkModule;
use miyoria_store::{
    AuditLog, AuthStore, DecisionLog, DecisionRecord, IdentityStore, LogEntry, MemoryRecordStore,
    MessageLog, PeopleStore, PersonaOverrideStore, RelationshipStore, SettingsStore, Store,
};
use miyoria_tools::ToolRegistry;
use miyoria_types::{
    AccountRef, Author, Event, IncomingMessage, MessageRef, ModuleId, ModuleStateKind,
    PlatformSinks, PlaybackState, ProfileId, PromptContributors, TurnId,
};
use miyoria_voice::{VoiceLinkModule, VoiceModule};
use tracing::{info, warn};

use crate::cli_platform::CliPlatform;

const KERNEL: &str = "kernel";

/// Every module the core knows about, for `miyoria module list`.
const MODULES: &[&str] = &[
    LlmModule::ID,
    SpeechModule::ID,
    VoiceLinkModule::ID,
    VoiceModule::ID,
    "scheduler",
    "agent",
    CommandsModule::ID,
    AuthModule::ID,
    SocialModule::ID,
    MoodModule::ID,
    MemoryModule::ID,
    InitiativeModule::ID,
    QueueModule::ID,
    McpModule::ID,
    StageLinkModule::ID,
    "extensions",
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
        shutdown_signal().await?;
        info!("shutting down");
        self.supervisor.stop_all().await;
        Ok(())
    }
}

/// Ctrl-C everywhere, plus SIGTERM on Unix (e.g. `docker stop`).
async fn shutdown_signal() -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate())?;
        tokio::select! {
            r = tokio::signal::ctrl_c() => r?,
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
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
    services.provide::<dyn MessageLog>(&kernel, store.messages.clone());
    services.provide::<dyn PeopleStore>(&kernel, store.people.clone());
    services.provide::<dyn MemoryRecordStore>(&kernel, store.memories.clone());
    services.provide::<dyn RelationshipStore>(&kernel, store.relationships.clone());
    services.provide::<dyn IdentityStore>(&kernel, store.identity.clone());
    services.provide::<dyn AuthStore>(&kernel, store.auth.clone());
    services.provide::<dyn AuditLog>(&kernel, store.audit.clone());
    // Registries other modules add to, independent of any one module's lifetime.
    services.provide(&kernel, Arc::new(ToolRegistry::new()));
    services.provide(&kernel, Arc::new(PromptContributors::new()));

    let mut profile = load_profile(config)?;
    for (key, body) in store.persona_overrides.current(&profile.id).await? {
        profile.set_section(&key, body);
    }
    let profile_display_name = profile.display_name().to_owned();
    let profile_voice = profile.voice.clone();
    let profile_id = profile.id.clone();
    services.provide(&kernel, Arc::new(profile_id.clone()));

    let social = SocialModule::new(&profile);
    let mood = MoodModule::new(profile_id.clone(), profile.manifest.mood);
    let mut modules: Vec<Arc<dyn Module>> = vec![
        Arc::new(llm_module(config, &profile)?),
        Arc::new(SpeechModule::with_default_factories(
            config.get::<SpeechConfig>("speech")?,
        )),
        Arc::new(VoiceLinkModule::new()),
        Arc::new(VoiceModule::new(profile_id.clone(), profile_voice)),
        Arc::new(SchedulerModule::new()),
        Arc::new(AgentModule::new(profile)),
        Arc::new(CommandsModule::new()),
        Arc::new(AuthModule::new()),
        Arc::new(social),
        Arc::new(mood),
        Arc::new(MemoryModule::new(
            profile_id.clone(),
            config.get::<EmbeddingConfig>("memory.embedding")?,
        )),
        Arc::new(InitiativeModule::new(profile_id.clone())),
        Arc::new(QueueModule::new()),
        Arc::new(McpModule::from_app_config(config)?),
        Arc::new(StageLinkModule::new()),
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
        let needs_token = [
            DiscordBotModule::ID,
            ApiModule::ID,
            VoiceLinkModule::ID,
            StageLinkModule::ID,
        ];
        if token_missing && needs_token.contains(&id.as_str()) {
            warn!(module = %id, "token is empty; module disabled");
            enabled = false;
        }
        supervisor.register(module, section, enabled).await;
    }

    // Each extension is a module of its own (`ext.<id>`), after the host.
    match miyoria_ext_host::discover(config) {
        Ok(found) => {
            for (dir, reason) in found.skipped {
                warn!(dir = %dir.display(), %reason, "extension skipped");
            }
            for m in found.modules {
                let id = m.module.manifest().id.clone();
                let mut enabled = m.enabled;
                if let Some(saved) = store.module_state.get(&id).await? {
                    enabled = enabled && saved;
                }
                supervisor.register(m.module, m.config, enabled).await;
            }
        }
        Err(e) => warn!(error = %e, "extension discovery failed"),
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

/// `recorder`: writes every message (hers included, voice transcripts and her
/// spoken lines too) to the message log, keeps the people table up to date
/// and stores the agent's decision traces.
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
            "voice.utterance",
            "voice.playback",
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
                        record(&store, &profile, msg, is_self, env.correlation).await;
                    }
                    Event::VoiceUtterance(u) => {
                        let msg = IncomingMessage {
                            id: MessageRef {
                                context: u.context.clone(),
                                id: u.id.clone(),
                            },
                            author: u.speaker.clone(),
                            text: u.text.clone(),
                            mentions_self: false,
                            reply_to_self: false,
                            attachments: Vec::new(),
                            ts: u.ended_at,
                        };
                        record(&store, &profile, &msg, false, env.correlation).await;
                    }
                    Event::VoicePlayback {
                        context,
                        turn,
                        state: PlaybackState::Started,
                        text,
                    } => {
                        let Some(account) =
                            own.iter().find(|a| a.platform == context.platform).cloned()
                        else {
                            continue;
                        };
                        let msg = IncomingMessage {
                            id: MessageRef {
                                context: context.clone(),
                                id: ulid::Ulid::new().to_string(),
                            },
                            author: Author {
                                account,
                                display_name: String::new(),
                                is_bot: true,
                            },
                            text: text.clone(),
                            mentions_self: false,
                            reply_to_self: false,
                            attachments: Vec::new(),
                            ts: env.ts,
                        };
                        record(&store, &profile, &msg, true, *turn).await;
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

async fn record(
    store: &Store,
    profile: &ProfileId,
    msg: &IncomingMessage,
    is_self: bool,
    turn: Option<TurnId>,
) {
    let mut entry = LogEntry::from_incoming(profile.clone(), msg, is_self);
    entry.turn = turn;
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
