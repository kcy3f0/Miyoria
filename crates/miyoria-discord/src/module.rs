use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::Context as _;
use async_trait::async_trait;
use miyoria_commands::{CommandRegistry, CommandsModule};
use miyoria_kernel::{Health, Module, ModuleContext, ModuleManifest};
use miyoria_types::PlatformSinks;
use parking_lot::Mutex;
use serenity::all::{Client, GatewayIntents};
use tracing::{info, warn};

use crate::config::DiscordConfig;
use crate::handler::{Handler, Shared};
use crate::mapping::{parse_user_ids, platform};

/// How long to wait for the gateway to close after a shutdown request.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// Gateway intents the bot needs. `MESSAGE_CONTENT` is privileged and must be
/// enabled in the Developer Portal.
pub fn intents() -> GatewayIntents {
    GatewayIntents::GUILDS
        | GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::DIRECT_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT
        | GatewayIntents::GUILD_MESSAGE_TYPING
        | GatewayIntents::DIRECT_MESSAGE_TYPING
}

/// Module `platform.discord.bot`: the official bot account. Text messages,
/// reactions, typing and slash commands; never voice.
pub struct DiscordBotModule {
    manifest: ModuleManifest,
    running: Mutex<Option<Arc<Shared>>>,
}

impl Default for DiscordBotModule {
    fn default() -> Self {
        Self::new()
    }
}

impl DiscordBotModule {
    pub const ID: &'static str = "platform.discord.bot";

    pub fn new() -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Discord bot")
                .description("Discord bot account: text messages and slash commands")
                .requires(CommandsModule::ID),
            running: Mutex::new(None),
        }
    }
}

#[async_trait]
impl Module for DiscordBotModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: DiscordConfig = ctx.config()?;
        config.validate()?;
        let self_ids = parse_user_ids(&config.self_account_ids)?;
        let registry = ctx.services().require::<CommandRegistry>()?;
        let sinks = ctx.services().get::<PlatformSinks>();
        if sinks.is_none() {
            warn!("PlatformSinks service missing; output actions cannot reach Discord");
        }
        let token = config.token.clone();
        let shared = Arc::new(Shared::new(config, self_ids, registry, sinks));
        *self.running.lock() = Some(shared.clone());

        let handler = Handler {
            mctx: ctx.clone(),
            shared,
        };
        let cancel = ctx.cancellation().clone();
        ctx.spawn("gateway", async move {
            let mut client = Client::builder(&token, intents())
                .event_handler(handler)
                .await
                .context("building Discord client")?;
            let shards = client.shard_manager.clone();
            let start = client.start();
            tokio::pin!(start);
            tokio::select! {
                result = &mut start => {
                    result.context("Discord gateway")?;
                    anyhow::bail!("Discord gateway closed unexpectedly");
                }
                () = cancel.cancelled() => {}
            }
            info!("shutting down Discord gateway");
            shards.shutdown_all().await;
            let _ = tokio::time::timeout(SHUTDOWN_GRACE, start).await;
            Ok(())
        });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        if let Some(shared) = self.running.lock().take() {
            shared.ready.store(false, Ordering::SeqCst);
            if let Some(sinks) = &shared.sinks {
                sinks.unregister(&platform());
            }
        }
        Ok(())
    }

    async fn health(&self) -> Health {
        match &*self.running.lock() {
            Some(shared) if shared.ready.load(Ordering::SeqCst) => Health::Healthy,
            Some(_) => Health::Degraded("connecting to Discord".to_owned()),
            None => Health::Unhealthy("not running".to_owned()),
        }
    }
}
