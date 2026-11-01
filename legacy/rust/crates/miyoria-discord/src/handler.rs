use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use miyoria_commands::{CommandRegistry, CommandReply, Invocation};
use miyoria_kernel::ModuleContext;
use miyoria_types::{ContextKind, Event, PlatformSinks};
use parking_lot::{Mutex, RwLock};
use serenity::all::{
    ChannelId, Command, CommandInteraction, Context, CreateAllowedMentions,
    CreateInteractionResponse, CreateInteractionResponseFollowup, CreateInteractionResponseMessage,
    EditInteractionResponse, EventHandler, GuildChannel, GuildId, Http, Interaction, Message,
    MessageType, Ready, TypingStartEvent, UserId,
};
use tracing::{debug, info, warn};

use crate::config::DiscordConfig;
use crate::mapping::{
    account, command_path, context_key, display_name, incoming_message, is_guild_admin, kind_of,
    platform, resolved_users, role_ids,
};
use crate::sink::DiscordSink;
use crate::slash::{build_tree, to_create_commands};
use crate::split::{MAX_MESSAGE_LEN, split_message};

/// Discord wants an interaction response within 3 s; defer after this.
const DEFER_AFTER: Duration = Duration::from_millis(1500);
/// Batches bursts of command registrations into one sync.
const SYNC_DEBOUNCE: Duration = Duration::from_secs(2);
const MAX_KIND_CACHE: usize = 10_000;

/// State shared by the gateway handler and the module.
pub(crate) struct Shared {
    pub config: DiscordConfig,
    /// The bot account plus every configured self account.
    pub self_ids: RwLock<HashSet<UserId>>,
    pub registry: Arc<CommandRegistry>,
    pub sinks: Option<Arc<PlatformSinks>>,
    pub ready: AtomicBool,
    sync_started: AtomicBool,
    kinds: Mutex<HashMap<ChannelId, ContextKind>>,
}

impl Shared {
    pub fn new(
        config: DiscordConfig,
        self_ids: HashSet<UserId>,
        registry: Arc<CommandRegistry>,
        sinks: Option<Arc<PlatformSinks>>,
    ) -> Self {
        Self {
            config,
            self_ids: RwLock::new(self_ids),
            registry,
            sinks,
            ready: AtomicBool::new(false),
            sync_started: AtomicBool::new(false),
            kinds: Mutex::new(HashMap::new()),
        }
    }

    fn remember_kind(&self, channel: ChannelId, kind: ContextKind) {
        let mut kinds = self.kinds.lock();
        if kinds.len() >= MAX_KIND_CACHE {
            kinds.clear();
        }
        kinds.insert(channel, kind);
    }
}

pub(crate) struct Handler {
    pub mctx: ModuleContext,
    pub shared: Arc<Shared>,
}

#[async_trait]
impl EventHandler for Handler {
    async fn ready(&self, ctx: Context, ready: Ready) {
        let bot = ready.user.id;
        info!(user = %ready.user.name, id = %bot, guilds = ready.guilds.len(), "discord bot ready");
        let ids = {
            let mut ids = self.shared.self_ids.write();
            ids.insert(bot);
            let mut ids: Vec<UserId> = ids.iter().copied().filter(|id| *id != bot).collect();
            ids.sort();
            ids.insert(0, bot);
            ids
        };
        for id in ids {
            self.mctx.publish(Event::PlatformReady {
                platform: platform(),
                self_account: account(id),
            });
        }
        if let Some(sinks) = &self.shared.sinks {
            sinks.register(Arc::new(DiscordSink::new(ctx.http.clone())));
        }
        self.shared.ready.store(true, Ordering::SeqCst);

        if !self.shared.sync_started.swap(true, Ordering::SeqCst) {
            let shared = self.shared.clone();
            let http = ctx.http.clone();
            let cancel = self.mctx.cancellation().clone();
            self.mctx.spawn("command-sync", async move {
                let mut rx = shared.registry.subscribe();
                rx.borrow_and_update();
                sync_commands(&http, &shared).await;
                loop {
                    tokio::select! {
                        () = cancel.cancelled() => return Ok(()),
                        changed = rx.changed() => if changed.is_err() { return Ok(()) },
                    }
                    tokio::select! {
                        () = cancel.cancelled() => return Ok(()),
                        () = tokio::time::sleep(SYNC_DEBOUNCE) => {}
                    }
                    rx.borrow_and_update();
                    sync_commands(&http, &shared).await;
                }
            });
        }
    }

    async fn message(&self, ctx: Context, msg: Message) {
        if !matches!(msg.kind, MessageType::Regular | MessageType::InlineReply) {
            return;
        }
        if msg.content.is_empty() && msg.attachments.is_empty() {
            return;
        }
        let kind = self.channel_kind(&ctx, msg.guild_id, msg.channel_id).await;
        let self_ids = self.shared.self_ids.read().clone();
        let incoming = incoming_message(&msg, kind, &self_ids);
        self.mctx.publish(Event::PlatformMessageCreated(incoming));
    }

    async fn typing_start(&self, ctx: Context, event: TypingStartEvent) {
        let kind = self
            .channel_kind(&ctx, event.guild_id, event.channel_id)
            .await;
        self.mctx.publish(Event::PlatformTyping {
            context: context_key(event.guild_id, event.channel_id.get(), kind),
            account: account(event.user_id),
        });
    }

    async fn thread_create(&self, _ctx: Context, thread: GuildChannel) {
        self.shared.remember_kind(thread.id, kind_of(thread.kind));
    }

    async fn interaction_create(&self, ctx: Context, interaction: Interaction) {
        if let Interaction::Command(cmd) = interaction {
            self.handle_command(&ctx, cmd).await;
        }
    }
}

impl Handler {
    /// Channel / thread / DM, from the gateway cache, a memo, or REST.
    async fn channel_kind(
        &self,
        ctx: &Context,
        guild: Option<GuildId>,
        channel: ChannelId,
    ) -> ContextKind {
        let Some(guild) = guild else {
            return ContextKind::Dm;
        };
        if let Some(kind) = self.shared.kinds.lock().get(&channel) {
            return *kind;
        }
        let cached = ctx.cache.guild(guild).and_then(|g| {
            g.channels
                .get(&channel)
                .or_else(|| g.threads.iter().find(|t| t.id == channel))
                .map(|c| kind_of(c.kind))
        });
        let kind = match cached {
            Some(kind) => kind,
            None => match ctx.http.get_channel(channel).await {
                Ok(c) => c.guild().map_or(ContextKind::Channel, |g| kind_of(g.kind)),
                Err(e) => {
                    debug!(%channel, error = %e, "cannot resolve channel kind");
                    return ContextKind::Channel;
                }
            },
        };
        self.shared.remember_kind(channel, kind);
        kind
    }

    async fn handle_command(&self, ctx: &Context, cmd: CommandInteraction) {
        let (path, args) = command_path(&cmd.data.name, &cmd.data.options);
        let kind = match (&cmd.channel, cmd.guild_id) {
            (_, None) => ContextKind::Dm,
            (Some(channel), Some(_)) => kind_of(channel.kind),
            (None, guild) => self.channel_kind(ctx, guild, cmd.channel_id).await,
        };
        let nick = cmd.member.as_ref().and_then(|m| m.nick.as_deref());
        let invocation = Invocation {
            path,
            args,
            invoker: account(cmd.user.id),
            invoker_display_name: display_name(&cmd.user, nick),
            context: context_key(cmd.guild_id, cmd.channel_id.get(), kind),
            invoker_is_guild_admin: is_guild_admin(cmd.member.as_deref()),
            platform_roles: cmd
                .member
                .as_ref()
                .map(|m| role_ids(&m.roles))
                .unwrap_or_default(),
            resolved_users: resolved_users(&cmd.data.resolved),
        };
        let name = invocation.path.join(" ");
        let registry = self.shared.registry.clone();
        let default_ephemeral = registry.get(&invocation.path).is_none_or(|s| s.ephemeral);
        debug!(command = %name, user = %cmd.user.id, "slash command");

        let dispatch = async move { registry.dispatch(invocation).await };
        tokio::pin!(dispatch);
        let outcome = match tokio::time::timeout(DEFER_AFTER, &mut dispatch).await {
            Ok(result) => respond(&ctx.http, &cmd, to_reply(result, &name), None).await,
            Err(_) => {
                let defer = CreateInteractionResponse::Defer(
                    CreateInteractionResponseMessage::new().ephemeral(default_ephemeral),
                );
                if let Err(e) = cmd.create_response(&ctx.http, defer).await {
                    warn!(command = %name, error = %e, "cannot defer interaction");
                }
                let reply = to_reply(dispatch.await, &name);
                respond(&ctx.http, &cmd, reply, Some(default_ephemeral)).await
            }
        };
        if let Err(e) = outcome {
            warn!(command = %name, error = %e, "cannot respond to interaction");
        }
    }
}

fn to_reply(result: anyhow::Result<CommandReply>, name: &str) -> CommandReply {
    result.unwrap_or_else(|e| {
        warn!(command = %name, error = format!("{e:#}"), "command handler failed");
        CommandReply::ephemeral("嗚……執行的時候出錯了。才不是我的問題,去看 log 啦。")
    })
}

/// Sends `reply`, split into chunks. `deferred` is the visibility the
/// interaction was deferred with, if it was.
async fn respond(
    http: &Http,
    cmd: &CommandInteraction,
    reply: CommandReply,
    deferred: Option<bool>,
) -> serenity::Result<()> {
    let ephemeral = reply.ephemeral;
    let mut chunks = split_message(&reply.text, MAX_MESSAGE_LEN).into_iter();
    let first = chunks.next().unwrap_or_else(|| "……".to_owned());
    let followup = |text: String| {
        CreateInteractionResponseFollowup::new()
            .content(text)
            .ephemeral(ephemeral)
            .allowed_mentions(CreateAllowedMentions::new())
    };
    match deferred {
        None => {
            let message = CreateInteractionResponseMessage::new()
                .content(first)
                .ephemeral(ephemeral)
                .allowed_mentions(CreateAllowedMentions::new());
            cmd.create_response(http, CreateInteractionResponse::Message(message))
                .await?;
        }
        Some(was) if was == ephemeral => {
            let edit = EditInteractionResponse::new()
                .content(first)
                .allowed_mentions(CreateAllowedMentions::new());
            cmd.edit_response(http, edit).await?;
        }
        // Visibility of a deferred response cannot change: replace it.
        Some(_) => {
            cmd.create_followup(http, followup(first)).await?;
            cmd.delete_response(http).await?;
        }
    }
    for chunk in chunks {
        cmd.create_followup(http, followup(chunk)).await?;
    }
    Ok(())
}

/// Overwrites the application commands with the registry's current set.
async fn sync_commands(http: &Http, shared: &Shared) {
    let tree = build_tree(&shared.registry.specs(), |p| {
        shared.registry.group_description(p)
    });
    let commands = to_create_commands(&tree);
    let count = commands.len();
    if shared.config.command_guilds.is_empty() {
        match Command::set_global_commands(http, commands).await {
            Ok(_) => info!(count, "synced global slash commands"),
            Err(e) => warn!(error = %e, "cannot sync global slash commands"),
        }
        return;
    }
    for guild in &shared.config.command_guilds {
        let guild = GuildId::new(*guild);
        match guild.set_commands(http, commands.clone()).await {
            Ok(_) => info!(%guild, count, "synced guild slash commands"),
            Err(e) => warn!(%guild, error = %e, "cannot sync guild slash commands"),
        }
    }
}
