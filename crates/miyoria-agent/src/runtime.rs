use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use miyoria_kernel::{ModuleContext, Subscription, TopicFilter};
use miyoria_types::{
    AccountRef, ActionId, ContextKey, Envelope, Event, IncomingMessage, ModuleStateKind, PlatformId,
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
    Message(Box<IncomingMessage>),
    Typing,
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

    fn on_message(self: &Arc<Self>, msg: &IncomingMessage) {
        let is_self = self.is_self(&msg.author.account);
        let mut contexts = self.contexts.lock();
        let key = msg.context().clone();
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
        handle.session.lock().record_message(msg, is_self);
        if is_self || (msg.author.is_bot && !self.config.respond_to_bots) {
            return;
        }
        let _ = handle.tx.send(Input::Message(Box::new(msg.clone())));
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
