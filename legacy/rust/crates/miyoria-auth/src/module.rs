use std::collections::HashSet;
#[cfg(feature = "commands")]
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use async_trait::async_trait;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest, TopicFilter};
use miyoria_store::{AuditLog, AuthStore};
use miyoria_types::{AccountRef, Authorizer, Event, ModuleStateKind, PlatformId};
use serde::Deserialize;
use tracing::warn;

use crate::builtin::USER;
use crate::service::AuthService;

/// How long the initial seed and load may take.
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);
const COMMANDS_MODULE: &str = "commands";

/// `[modules.auth]` config section.
///
/// ```toml
/// [modules.auth]
/// owners = ["discord:123456789012345678"]
/// default_role = "user"
/// refresh_secs = 300
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct AuthConfig {
    /// Accounts that are always `owner`, as `"platform:id"`. Owners listed in
    /// `[modules.commands] owners` count too.
    pub owners: Vec<String>,
    /// Role of accounts nothing else applies to.
    pub default_role: String,
    /// Re-read the store this often to pick up changes made elsewhere;
    /// 0 turns it off.
    pub refresh_secs: u64,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            owners: Vec::new(),
            default_role: USER.to_owned(),
            refresh_secs: 300,
        }
    }
}

impl AuthConfig {
    pub fn owner_accounts(&self) -> anyhow::Result<Vec<AccountRef>> {
        self.owners.iter().map(|s| parse_account(s)).collect()
    }
}

/// Parses `"platform:id"` into an [`AccountRef`].
pub fn parse_account(s: &str) -> anyhow::Result<AccountRef> {
    match s.trim().split_once(':') {
        Some((platform, id)) if !platform.is_empty() && !id.is_empty() => Ok(AccountRef {
            platform: PlatformId::new(platform),
            id: id.to_owned(),
        }),
        _ => anyhow::bail!("invalid account `{s}`, expected `platform:id`"),
    }
}

/// Module `auth`: role-based permissions.
///
/// Requires the `Arc<dyn AuthStore>` service and uses `Arc<dyn AuditLog>`
/// when present. Provides `Arc<AuthService>` and `Arc<dyn Authorizer>`
/// (replacing the `commands` module's fallback) and, with the `commands`
/// feature, `Arc<dyn AuthorizerPreload>` and the `admin role` / `admin perm`
/// commands.
pub struct AuthModule {
    manifest: ModuleManifest,
    #[cfg(feature = "commands")]
    commands: Arc<crate::commands::AuthCommands>,
}

impl Default for AuthModule {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthModule {
    pub const ID: &'static str = "auth";

    pub fn new() -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Permissions")
                .description("Roles, permission nodes and platform role mappings")
                // Started after `commands` so its authorizer replaces the fallback.
                .optional(COMMANDS_MODULE),
            #[cfg(feature = "commands")]
            commands: Arc::default(),
        }
    }
}

#[async_trait]
impl Module for AuthModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: AuthConfig = ctx.config()?;
        let config_owners = config.owner_accounts()?;
        let store = ctx.services().require::<dyn AuthStore>()?;
        let audit = ctx.services().get::<dyn AuditLog>();
        if audit.is_none() {
            warn!("AuditLog service missing; permission changes are not audited");
        }
        let owners = all_owners(&ctx, &config_owners);
        let service = tokio::time::timeout(
            LOAD_TIMEOUT,
            AuthService::load(store, audit, owners, &config.default_role),
        )
        .await
        .context("loading permissions timed out")??;

        ctx.provide(service.clone());
        ctx.provide::<dyn Authorizer>(service.clone());
        #[cfg(feature = "commands")]
        {
            ctx.provide::<dyn miyoria_commands::AuthorizerPreload>(service.clone());
            self.commands.install(ctx.services(), &service);
        }

        let mut events = ctx.subscribe(TopicFilter::new(["system.module.state"]));
        let refresh = (config.refresh_secs > 0).then(|| Duration::from_secs(config.refresh_secs));
        let cancel = ctx.cancellation().clone();
        let c = ctx.clone();
        #[cfg(feature = "commands")]
        let commands = self.commands.clone();
        ctx.spawn("events", async move {
            let mut tick = refresh.map(|period| {
                tokio::time::interval_at(tokio::time::Instant::now() + period, period)
            });
            loop {
                tokio::select! {
                    () = cancel.cancelled() => return Ok(()),
                    env = events.recv() => {
                        let Some(env) = env else { return Ok(()) };
                        let commands_up = matches!(
                            &env.event,
                            Event::ModuleStateChanged {
                                module,
                                state: ModuleStateKind::Running,
                                ..
                            } if module.as_str() == COMMANDS_MODULE
                        );
                        if commands_up {
                            service.set_owners(all_owners(&c, &config_owners));
                            #[cfg(feature = "commands")]
                            commands.install(c.services(), &service);
                        }
                    }
                    _ = async { tick.as_mut().unwrap().tick().await }, if tick.is_some() => {
                        service.set_owners(all_owners(&c, &config_owners));
                        if let Err(e) = service.reload().await {
                            warn!(error = %format!("{e:#}"), "cannot refresh permissions");
                        }
                    }
                }
            }
        });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        #[cfg(feature = "commands")]
        self.commands.uninstall();
        Ok(())
    }
}

/// Config owners plus `[modules.commands] owners`, if that module runs.
fn all_owners(ctx: &ModuleContext, config_owners: &[AccountRef]) -> Vec<AccountRef> {
    #[allow(unused_mut)]
    let mut owners: HashSet<AccountRef> = config_owners.iter().cloned().collect();
    #[cfg(feature = "commands")]
    if let Some(registry) = ctx.services().get::<miyoria_commands::CommandRegistry>() {
        owners.extend(registry.permissions().owners().cloned());
    }
    #[cfg(not(feature = "commands"))]
    let _ = ctx;
    owners.into_iter().collect()
}
