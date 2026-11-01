use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use miyoria_commands::CommandRegistry;
use miyoria_kernel::{
    Module, ModuleContext, ModuleManifest, ServiceRegistry, Subscription, TopicFilter,
};
use miyoria_llm::LlmRouter;
use miyoria_profile::Profile;
use miyoria_store::{IdentityStore, PeopleStore, RelationshipStore, Store};
use miyoria_types::{
    Authorizer, ContextKey, ContextKind, Event, ModuleId, PersonId, ProfileId, PromptContributors,
    SocialSignals,
};
use parking_lot::Mutex;
use tracing::{info, warn};

use super::commands;
use super::config::SocialConfig;
use super::engine::{Observed, Publisher, Social, SocialStores};
use super::prompt::SocialPrompt;

/// Module `social`. Requires `llm`; `commands` is optional.
///
/// Services used: `dyn RelationshipStore` (required), `dyn PeopleStore` (or
/// the `Store` bundle), `dyn IdentityStore` (optional, for `/link`),
/// `PromptContributors`, `CommandRegistry` and `dyn Authorizer` (optional).
/// Provides `Arc<dyn SocialSignals>` and `Arc<Social>`.
pub struct SocialModule {
    manifest: ModuleManifest,
    profile: ProfileId,
    her_name: String,
    names: Vec<String>,
    running: Mutex<Option<Running>>,
}

struct Running {
    social: Arc<Social>,
    registry: Option<Arc<CommandRegistry>>,
    contributors: Option<Arc<PromptContributors>>,
}

impl SocialModule {
    pub const ID: &'static str = "social";

    /// Uses the profile's id, display name and nicknames.
    pub fn new(profile: &Profile) -> Self {
        Self::with_names(
            profile.id.clone(),
            profile.display_name(),
            profile.names().map(str::to_owned).collect(),
        )
    }

    pub fn with_names(profile: ProfileId, her_name: &str, names: Vec<String>) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Social")
                .description("Relationships, appraisal and account linking")
                .requires("llm")
                .optional("commands"),
            profile,
            her_name: her_name.to_owned(),
            names,
            running: Mutex::new(None),
        }
    }
}

fn stores(services: &ServiceRegistry) -> anyhow::Result<SocialStores> {
    let bundle = services.get::<Store>();
    let people = services
        .get::<dyn PeopleStore>()
        .or_else(|| bundle.map(|s| s.people.clone()))
        .ok_or_else(|| anyhow::anyhow!("social needs a `dyn PeopleStore` (or `Store`) service"))?;
    let relationships = services
        .get::<dyn RelationshipStore>()
        .ok_or_else(|| anyhow::anyhow!("social needs a `dyn RelationshipStore` service"))?;
    let identity = services.get::<dyn IdentityStore>();
    if identity.is_none() {
        warn!("no identity store: `/link` is unavailable");
    }
    Ok(SocialStores {
        people,
        relationships,
        identity,
    })
}

#[async_trait]
impl Module for SocialModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: SocialConfig = ctx.config()?;
        let stores = stores(ctx.services())?;
        let publish: Publisher = {
            let bus = ctx.bus().clone();
            let id: ModuleId = ctx.id().clone();
            Arc::new(move |event| bus.publish(&id, event, None))
        };
        let social = Arc::new(Social::new(
            self.profile.clone(),
            self.her_name.clone(),
            self.names.clone(),
            config,
            stores,
            publish,
        ));
        social.set_authorizer(ctx.services().get::<dyn Authorizer>());
        social.load().await?;

        ctx.provide::<dyn SocialSignals>(social.clone());
        ctx.provide(social.clone());

        let contributors = ctx.services().get::<PromptContributors>();
        if let Some(c) = &contributors {
            c.register(Arc::new(SocialPrompt::new(social.clone())));
        }
        let registry = ctx.services().get::<CommandRegistry>();
        if let Some(r) = &registry {
            commands::register_commands(r, social.clone())?;
        }
        *self.running.lock() = Some(Running {
            social: social.clone(),
            registry,
            contributors,
        });

        // Subscribe before returning so no event published after start is missed.
        let sub = ctx.subscribe(TopicFilter::new([
            "platform.ready",
            "platform.message.created",
            "voice.utterance",
            "agent.turn.completed",
        ]));
        ctx.spawn("events", run_events(ctx.clone(), social.clone(), sub));
        ctx.spawn("tick", run_tick(ctx.clone(), social));
        info!("social module running");
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        let running = self.running.lock().take();
        if let Some(r) = running {
            if let Some(reg) = &r.registry {
                commands::unregister_commands(reg);
            }
            if let Some(c) = &r.contributors {
                c.unregister(SocialPrompt::KEY);
            }
            r.social.flush().await?;
        }
        Ok(())
    }
}

async fn run_events(
    ctx: ModuleContext,
    social: Arc<Social>,
    mut sub: Subscription,
) -> anyhow::Result<()> {
    let cancel = ctx.cancellation().clone();
    loop {
        let env = tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            env = sub.recv() => match env {
                Some(env) => env,
                None => return Ok(()),
            },
        };
        let now = Utc::now();
        let observed = match &env.event {
            Event::PlatformReady { self_account, .. } => {
                social.add_self_account(self_account.clone());
                None
            }
            Event::PlatformMessageCreated(m) => {
                let own = m.author.is_bot || social.is_self(&m.author.account);
                (!own).then(|| Observed {
                    context: m.context().clone(),
                    account: m.author.account.clone(),
                    display_name: m.author.display_name.clone(),
                    text: m.text.clone(),
                    directed: m.mentions_self
                        || m.reply_to_self
                        || m.context().kind == ContextKind::Dm,
                    ts: now,
                })
            }
            Event::VoiceUtterance(u) => {
                let own = u.speaker.is_bot || social.is_self(&u.speaker.account);
                (!own).then(|| Observed {
                    context: u.context.clone(),
                    account: u.speaker.account.clone(),
                    display_name: u.speaker.display_name.clone(),
                    text: u.text.clone(),
                    directed: false,
                    ts: now,
                })
            }
            Event::AgentTurnCompleted { context, text, .. } => {
                social.observe_self(context, text, now);
                None
            }
            _ => None,
        };
        let Some(line) = observed else { continue };
        let key = line.context.clone();
        match social.observe(line).await {
            Ok(true) => spawn_appraisal(&ctx, &social, key),
            Ok(false) => {}
            Err(e) => warn!(error = %e, context = %key, "social appraisal of a line failed"),
        }
    }
}

async fn run_tick(ctx: ModuleContext, social: Arc<Social>) -> anyhow::Result<()> {
    let period = Duration::from_secs(social.config().tick_secs.max(1));
    let mut tick = tokio::time::interval(period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let cancel = ctx.cancellation().clone();
    loop {
        tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            _ = tick.tick() => {}
        }
        // The authorizer may be replaced at runtime (e.g. by `auth`).
        social.set_authorizer(ctx.services().get::<dyn Authorizer>());
        let now = Utc::now();
        for key in social.due_appraisals(now) {
            spawn_appraisal(&ctx, &social, key);
        }
        if let Some(person) = social.due_notes(now).into_iter().next() {
            spawn_notes(&ctx, &social, person);
        }
        if let Err(e) = social.flush().await {
            warn!(error = %e, "cannot write relationship counters");
        }
    }
}

fn spawn_appraisal(ctx: &ModuleContext, social: &Arc<Social>, key: ContextKey) {
    let Some(router) = ctx.services().get::<LlmRouter>() else {
        return;
    };
    let social = social.clone();
    ctx.spawn("appraisal", async move {
        if let Err(e) = social.appraise(&router, &key, Utc::now()).await {
            warn!(error = %e, context = %key, "LLM appraisal failed");
        }
        Ok(())
    });
}

fn spawn_notes(ctx: &ModuleContext, social: &Arc<Social>, person: PersonId) {
    let Some(router) = ctx.services().get::<LlmRouter>() else {
        return;
    };
    let social = social.clone();
    ctx.spawn("notes", async move {
        if let Err(e) = social.refresh_notes(&router, person, Utc::now()).await {
            warn!(error = %e, %person, "notes refresh failed");
        }
        Ok(())
    });
}
