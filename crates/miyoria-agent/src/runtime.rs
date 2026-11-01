use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::Utc;
use miyoria_kernel::{ModuleContext, Subscription, TopicFilter};
use miyoria_types::{
    AccountRef, ActionId, ContextKey, ContextKind, Envelope, Event, IncomingMessage, MessageRef,
    ModuleStateKind, PlatformId, PlaybackState, TurnId, VoiceParticipant, VoiceUtterance,
};
use parking_lot::{Mutex, RwLock};
use tokio::sync::mpsc;
use tracing::debug;

use crate::attention::RandomSource;
use crate::commands::AgentCommands;
use crate::config::AgentConfig;
use crate::coordinator::Coordinator;
use crate::handle::AgentHandle;
use crate::persona::PersonaHandle;
use crate::session::Session;
use crate::tools::ToolRegistry;

/// Module whose restart means the agent commands must be registered again.
const COMMANDS_MODULE: &str = "commands";

pub(crate) enum Input {
    /// A platform message or a voice utterance (as a message).
    Message(Box<IncomingMessage>),
    Typing,
    /// Someone in the voice channel started or stopped speaking.
    Speaking,
    /// Playback of her speech for `turn` changed.
    Playback {
        turn: TurnId,
        state: PlaybackState,
    },
}

struct ContextHandle {
    session: Arc<Mutex<Session>>,
    tx: mpsc::UnboundedSender<Input>,
}

/// State shared by the event loop, the per-context coordinators and turns.
pub(crate) struct Agent {
    pub ctx: ModuleContext,
    pub config: AgentConfig,
    pub persona: PersonaHandle,
    pub random: Arc<dyn RandomSource>,
    pub handle: Arc<AgentHandle>,
    pub tools: Arc<ToolRegistry>,
    commands: Arc<AgentCommands>,
    self_accounts: RwLock<HashSet<AccountRef>>,
    contexts: Mutex<HashMap<ContextKey, ContextHandle>>,
    /// Her submitted messages awaiting `action.completed`.
    pending_actions: Mutex<HashMap<ActionId, Arc<Mutex<Session>>>>,
}

impl Agent {
    pub fn new(
        ctx: ModuleContext,
        config: AgentConfig,
        persona: PersonaHandle,
        random: Arc<dyn RandomSource>,
        handle: Arc<AgentHandle>,
        tools: Arc<ToolRegistry>,
        commands: Arc<AgentCommands>,
    ) -> Self {
        Self {
            ctx,
            config,
            persona,
            random,
            handle,
            tools,
            commands,
            self_accounts: RwLock::new(HashSet::new()),
            contexts: Mutex::new(HashMap::new()),
            pending_actions: Mutex::new(HashMap::new()),
        }
    }

    pub fn topics() -> TopicFilter {
        TopicFilter::new([
            "platform.ready",
            "platform.message.created",
            "platform.typing",
            "voice.*",
            "action.completed",
            "system.module.state",
        ])
    }

    pub async fn run(self: Arc<Self>, mut sub: Subscription) -> anyhow::Result<()> {
        let cancel = self.ctx.cancellation().clone();
        loop {
            let env = tokio::select! {
                () = cancel.cancelled() => return Ok(()),
                env = sub.recv() => env,
            };
            match env {
                Some(env) => self.handle(&env),
                None => return Ok(()),
            }
        }
    }

    fn handle(self: &Arc<Self>, env: &Envelope) {
        match &env.event {
            Event::PlatformReady { self_account, .. } => {
                debug!(platform = %self_account.platform, id = %self_account.id, "self account ready");
                self.self_accounts.write().insert(self_account.clone());
            }
            Event::PlatformMessageCreated(msg) => self.on_message(msg),
            Event::PlatformTyping { context, account } => {
                if !self.is_self(account) {
                    if let Some(handle) = self.contexts.lock().get(context) {
                        let _ = handle.tx.send(Input::Typing);
                    }
                }
            }
            Event::VoiceJoined {
                context,
                participants,
            }
            | Event::VoiceParticipants {
                context,
                participants,
            } if is_voice(context) => self.on_voice_members(context, participants),
            Event::VoiceLeft { context, reason } if is_voice(context) => {
                debug!(%context, ?reason, "left voice, session dropped");
                self.handle.set_voice_room(context, false);
                // Dropping the sender stops the coordinator (and its turn).
                self.contexts.lock().remove(context);
            }
            Event::VoiceSpeaking {
                context,
                account,
                speaking,
            } if is_voice(context) && !self.is_self(account) => {
                self.with_existing(context, |h| {
                    h.session.lock().set_speaking(account, *speaking);
                    let _ = h.tx.send(Input::Speaking);
                });
            }
            Event::VoiceUtterance(utterance) if is_voice(&utterance.context) => {
                self.on_utterance(utterance);
            }
            Event::VoicePlayback {
                context,
                turn,
                state,
                text,
            } if is_voice(context) => self.on_playback(context, *turn, *state, text),
            Event::ActionCompleted { action, ok, .. } => {
                let session = self.pending_actions.lock().remove(action);
                if let (Some(session), false) = (session, ok) {
                    session.lock().forget_action(*action);
                }
            }
            Event::ModuleStateChanged {
                module,
                state: ModuleStateKind::Running,
                ..
            } if module.as_str() == COMMANDS_MODULE => {
                self.commands.install(
                    self.ctx.services(),
                    self.handle.clone(),
                    self.persona.clone(),
                );
            }
            _ => {}
        }
    }

    /// Runs `f` with the context's handle, creating the context (session and
    /// coordinator) if needed.
    fn with_context<R>(
        self: &Arc<Self>,
        key: &ContextKey,
        f: impl FnOnce(&ContextHandle) -> R,
    ) -> R {
        let mut contexts = self.contexts.lock();
        let handle = contexts.entry(key.clone()).or_insert_with(|| {
            let session = Arc::new(Mutex::new(Session::new(
                key.clone(),
                self.config.history_limit,
            )));
            let (tx, rx) = mpsc::unbounded_channel();
            let coordinator = Coordinator::new(self.clone(), key.clone(), session.clone(), rx);
            self.ctx.spawn("context", coordinator.run());
            ContextHandle { session, tx }
        });
        f(handle)
    }

    /// Runs `f` with the context's handle if the context exists (a stray
    /// signal after she left must not bring a session back).
    fn with_existing(&self, key: &ContextKey, f: impl FnOnce(&ContextHandle)) {
        if let Some(handle) = self.contexts.lock().get(key) {
            f(handle);
        }
    }

    fn on_message(self: &Arc<Self>, msg: &IncomingMessage) {
        let is_self = self.is_self(&msg.author.account);
        let ignored = is_self || (msg.author.is_bot && !self.config.respond_to_bots);
        self.with_context(msg.context(), |handle| {
            handle.session.lock().record_message(msg, is_self);
            if !ignored {
                let _ = handle.tx.send(Input::Message(Box::new(msg.clone())));
            }
        });
    }

    fn on_voice_members(self: &Arc<Self>, context: &ContextKey, members: &[VoiceParticipant]) {
        self.handle.set_voice_room(context, true);
        {
            let mut own = self.self_accounts.write();
            for m in members.iter().filter(|m| m.is_self) {
                own.insert(m.account.clone());
            }
        }
        let others: Vec<VoiceParticipant> =
            members.iter().filter(|m| !m.is_self).cloned().collect();
        self.with_context(context, |h| h.session.lock().set_voice_members(others));
    }

    fn on_utterance(self: &Arc<Self>, utterance: &VoiceUtterance) {
        if utterance.text.trim().is_empty() || self.is_self(&utterance.speaker.account) {
            return;
        }
        self.handle.set_voice_room(&utterance.context, true);
        let msg = utterance_message(utterance);
        let ignored = msg.author.is_bot && !self.config.respond_to_bots;
        self.with_context(&utterance.context, |handle| {
            handle.session.lock().record_utterance(&msg);
            if !ignored {
                let _ = handle.tx.send(Input::Message(Box::new(msg)));
            }
        });
    }

    /// Her own speech enters history once it starts playing.
    fn on_playback(
        self: &Arc<Self>,
        context: &ContextKey,
        turn: Option<TurnId>,
        state: PlaybackState,
        text: &str,
    ) {
        let name = self.persona.display_name();
        let me = self.self_account(&context.platform);
        let now = Utc::now();
        self.with_existing(context, |h| {
            {
                let mut session = h.session.lock();
                match state {
                    PlaybackState::Started => session.record_speech(&name, me, text, turn, now),
                    PlaybackState::Interrupted => {
                        session.record_interruption(&name, me, text, turn, now);
                    }
                    PlaybackState::Finished => session.note_self_spoke(now),
                    PlaybackState::Failed => {}
                }
            }
            if let Some(turn) = turn {
                let _ = h.tx.send(Input::Playback { turn, state });
            }
        });
    }

    fn is_self(&self, account: &AccountRef) -> bool {
        self.self_accounts.read().contains(account)
    }

    /// One of her accounts on `platform`, used to attribute her replies.
    pub fn self_account(&self, platform: &PlatformId) -> AccountRef {
        let accounts = self.self_accounts.read();
        let mut ids: Vec<_> = accounts
            .iter()
            .filter(|a| &a.platform == platform)
            .collect();
        ids.sort_by(|a, b| a.id.cmp(&b.id));
        ids.first().map_or_else(
            || AccountRef {
                platform: platform.clone(),
                id: "self".into(),
            },
            |a| (*a).clone(),
        )
    }

    pub fn track_action(&self, action: ActionId, session: Arc<Mutex<Session>>) {
        self.pending_actions.lock().insert(action, session);
    }

    pub fn untrack_action(&self, action: ActionId) {
        self.pending_actions.lock().remove(&action);
    }

    /// Removes an idle context unless input is waiting for it.
    pub fn retire(&self, key: &ContextKey, rx: &mpsc::UnboundedReceiver<Input>) -> bool {
        let mut contexts = self.contexts.lock();
        if rx.is_empty() {
            contexts.remove(key);
            true
        } else {
            false
        }
    }
}

fn is_voice(context: &ContextKey) -> bool {
    if context.kind == ContextKind::Voice {
        true
    } else {
        debug!(%context, "ignoring voice event for a non-voice context");
        false
    }
}

/// A voice utterance as turn input. Its `MessageRef` names the utterance, not
/// a platform message.
fn utterance_message(u: &VoiceUtterance) -> IncomingMessage {
    IncomingMessage {
        id: MessageRef {
            context: u.context.clone(),
            id: u.id.clone(),
        },
        author: u.speaker.clone(),
        text: u.text.trim().to_owned(),
        mentions_self: false,
        reply_to_self: false,
        attachments: Vec::new(),
        ts: u.ended_at,
    }
}
