//! Turn coordinator: one per conversation context.
//!
//! Debounces incoming messages into turns, keeps at most one turn in flight
//! and restarts the turn when new input arrives before its reply was
//! committed. A text reply is committed once it is handed to the scheduler; a
//! voice reply once it starts playing, so a finished voice turn whose speech
//! is still queued is cancelled and regenerated too.
//!
//! In voice channels the debounce is shorter, but it is extended (up to
//! `voice.max_debounce_ms`) while someone is speaking.
//!
//! An initiative request starts a turn without input, but only when the
//! context is quiet: no turn in flight, no debounce pending, no speech of hers
//! still queued and her last words older than the ambient cooldown.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use miyoria_types::{
    ActionSink, ContextKey, ContextKind, Event, IncomingMessage, PlaybackState, TurnId,
};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::debug;

use crate::runtime::{Agent, Initiative, Input};
use crate::session::Session;
use crate::turn;

/// Shared between a turn and its coordinator.
#[derive(Debug, Default)]
pub(crate) struct TurnFlags {
    /// Text: the reply was handed to the scheduler. Voice: her speech started
    /// playing. From then on new input no longer cancels the turn.
    pub committed: AtomicBool,
    /// Voice: at least one sentence was submitted.
    pub queued: AtomicBool,
    /// Voice: her speech was interrupted; submit no further sentences.
    pub interrupted: AtomicBool,
}

impl TurnFlags {
    pub fn get(flag: &AtomicBool) -> bool {
        flag.load(Ordering::SeqCst)
    }

    pub fn set(flag: &AtomicBool) {
        flag.store(true, Ordering::SeqCst);
    }
}

struct Running {
    turn: TurnId,
    inputs: Vec<IncomingMessage>,
    flags: Arc<TurnFlags>,
    fut: BoxFuture<'static, ()>,
}

/// A finished voice turn whose speech is queued but has not started playing.
struct Unplayed {
    turn: TurnId,
    inputs: Vec<IncomingMessage>,
    since: Instant,
}

enum Wake {
    Stop,
    Input(Input),
    Deadline,
    TurnDone,
    Idle,
}

/// Debounce window: when it opened and when the turn should start.
#[derive(Clone, Copy)]
struct Window {
    opened: Instant,
    deadline: Instant,
}

pub(crate) struct Coordinator {
    agent: Arc<Agent>,
    key: ContextKey,
    session: Arc<Mutex<Session>>,
    rx: mpsc::UnboundedReceiver<Input>,
}

impl Coordinator {
    pub fn new(
        agent: Arc<Agent>,
        key: ContextKey,
        session: Arc<Mutex<Session>>,
        rx: mpsc::UnboundedReceiver<Input>,
    ) -> Self {
        Self {
            agent,
            key,
            session,
            rx,
        }
    }

    pub async fn run(mut self) -> anyhow::Result<()> {
        let cancel = self.agent.ctx.cancellation().clone();
        let cfg = self.agent.config.clone();
        let voice = self.key.kind == ContextKind::Voice;
        let (debounce, max_debounce) = if voice {
            (cfg.voice.debounce(), cfg.voice.max_debounce())
        } else {
            (cfg.debounce(), cfg.max_debounce())
        };
        let mut pending: Vec<IncomingMessage> = Vec::new();
        let mut window: Option<Window> = None;
        let mut running: Option<Running> = None;
        let mut unplayed: Option<Unplayed> = None;
        loop {
            let deadline = window.map(|w| w.deadline);
            // Voice contexts live until she leaves the channel.
            let idle = pending.is_empty() && running.is_none() && !voice;
            let wake = tokio::select! {
                () = cancel.cancelled() => Wake::Stop,
                input = self.rx.recv() => input.map_or(Wake::Stop, Wake::Input),
                () = sleep_until(deadline), if deadline.is_some() && running.is_none() => Wake::Deadline,
                () = poll(&mut running), if running.is_some() => Wake::TurnDone,
                () = tokio::time::sleep(cfg.session_idle()), if idle => Wake::Idle,
            };
            let now = Instant::now();
            match wake {
                Wake::Stop => {
                    if let Some(r) = running.take() {
                        self.abort(r).await;
                    }
                    if let Some(u) = unplayed.take() {
                        self.cancel(u.turn).await;
                    }
                    return Ok(());
                }
                Wake::Input(Input::Message(msg)) => {
                    if running
                        .as_ref()
                        .is_some_and(|r| !TurnFlags::get(&r.flags.committed))
                    {
                        let r = running.take().expect("checked above");
                        let mut merged = self.abort(r).await;
                        merged.append(&mut pending);
                        pending = merged;
                        window = None;
                    }
                    if let Some(u) = unplayed.take() {
                        if now < u.since + cfg.voice.speak_ttl() {
                            debug!(turn = %u.turn, context = %self.key, "speech not played yet, regenerating");
                            self.cancel(u.turn).await;
                            let mut merged = u.inputs;
                            merged.append(&mut pending);
                            pending = merged;
                            window = None;
                        }
                    }
                    pending.push(*msg);
                    let opened = window.map_or(now, |w| w.opened);
                    window = Some(Window {
                        opened,
                        deadline: (now + debounce).min(opened + max_debounce),
                    });
                }
                Wake::Input(Input::Typing) => {
                    if let Some(w) = &mut window {
                        w.deadline = w
                            .deadline
                            .max(now + cfg.typing_extend())
                            .min(w.opened + max_debounce);
                    }
                }
                Wake::Input(Input::Speaking) => {
                    // Started: do not answer over them. Stopped: give the
                    // transcript of what they said time to arrive.
                    if let Some(w) = &mut window {
                        w.deadline = w.deadline.max(now + debounce).min(w.opened + max_debounce);
                    }
                }
                Wake::Input(Input::Playback { turn, state }) => {
                    let flags = running
                        .as_ref()
                        .filter(|r| r.turn == turn)
                        .map(|r| r.flags.clone());
                    self.playback(turn, state, flags, &mut unplayed).await;
                }
                Wake::Deadline => {
                    if let Some(w) = &mut window {
                        let cap = w.opened + max_debounce;
                        if voice && now < cap && self.session.lock().someone_speaking() {
                            w.deadline = (now + debounce).min(cap);
                            continue;
                        }
                    }
                    window = None;
                    running = Some(self.start(std::mem::take(&mut pending), None));
                }
                Wake::Input(Input::Initiative(initiative)) => {
                    let busy = if running.is_some() {
                        Some("a turn is in flight")
                    } else if !pending.is_empty() {
                        Some("messages are waiting for a turn")
                    } else if unplayed.is_some() {
                        Some("her speech is still queued")
                    } else {
                        None
                    };
                    if let Some(why) = busy {
                        self.agent
                            .initiative_skipped(&self.key, &initiative.reason, why);
                        continue;
                    }
                    let last = self.session.lock().last_self_at();
                    let cooldown = self.agent.ambient_cooldown(&self.key);
                    // Live game commentary is rate-limited by the game director itself.
                    let last = last.filter(|_| initiative.reason != "game");
                    if let Some(last) = last {
                        let since = chrono::Utc::now().signed_duration_since(last);
                        if since < cooldown {
                            let why = format!(
                                "cooldown ({}ms since she spoke)",
                                since.num_milliseconds()
                            );
                            self.agent
                                .initiative_skipped(&self.key, &initiative.reason, &why);
                            continue;
                        }
                    }
                    running = Some(self.start(Vec::new(), Some(initiative)));
                }
                Wake::TurnDone => {
                    let r = running.take().expect("turn was running");
                    let flags = &r.flags;
                    if voice
                        && TurnFlags::get(&flags.queued)
                        && !TurnFlags::get(&flags.committed)
                        && !TurnFlags::get(&flags.interrupted)
                    {
                        unplayed = Some(Unplayed {
                            turn: r.turn,
                            inputs: r.inputs,
                            since: now,
                        });
                    }
                }
                Wake::Idle => {
                    if self.agent.retire(&self.key, &self.rx) {
                        debug!(context = %self.key, "context idle, session dropped");
                        return Ok(());
                    }
                }
            }
        }
    }

    fn start(&self, inputs: Vec<IncomingMessage>, initiative: Option<Initiative>) -> Running {
        let turn = TurnId::new();
        self.agent.ctx.publish_in_turn(
            Event::AgentTurnStarted {
                turn,
                context: self.key.clone(),
            },
            turn,
        );
        let flags = Arc::new(TurnFlags::default());
        let fut = turn::run(
            self.agent.clone(),
            self.key.clone(),
            self.session.clone(),
            turn,
            inputs.clone(),
            initiative,
            flags.clone(),
        );
        Running {
            turn,
            inputs,
            flags,
            fut: Box::pin(fut),
        }
    }

    /// Her speech of `turn` started, ended or was cut off (`running`: the
    /// flags of `turn` if it is the running turn).
    async fn playback(
        &self,
        turn: TurnId,
        state: PlaybackState,
        running: Option<Arc<TurnFlags>>,
        unplayed: &mut Option<Unplayed>,
    ) {
        if let Some(flags) = running {
            match state {
                PlaybackState::Started | PlaybackState::Finished => {
                    TurnFlags::set(&flags.committed);
                }
                PlaybackState::Interrupted => {
                    TurnFlags::set(&flags.committed);
                    TurnFlags::set(&flags.interrupted);
                }
                PlaybackState::Failed => {}
            }
        }
        if state != PlaybackState::Failed && unplayed.as_ref().is_some_and(|u| u.turn == turn) {
            *unplayed = None;
        }
        if state == PlaybackState::Interrupted {
            // The rest of what she meant to say would no longer fit.
            debug!(%turn, context = %self.key, "speech interrupted, dropping the rest");
            self.cancel(turn).await;
        }
    }

    /// Drops the queued actions of `turn`.
    async fn cancel(&self, turn: TurnId) {
        if let Some(sink) = self.agent.ctx.services().get::<dyn ActionSink>() {
            let _ = sink.cancel_turn(turn).await;
        }
    }

    /// Cancels a turn whose reply was not committed yet; returns its inputs.
    async fn abort(&self, running: Running) -> Vec<IncomingMessage> {
        let Running {
            turn, inputs, fut, ..
        } = running;
        drop(fut);
        debug!(%turn, context = %self.key, "turn cancelled by new input");
        self.cancel(turn).await;
        self.agent.ctx.publish_in_turn(
            Event::AgentTurnCompleted {
                turn,
                context: self.key.clone(),
                text: String::new(),
            },
            turn,
        );
        inputs
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

async fn poll(running: &mut Option<Running>) {
    match running {
        Some(r) => r.fut.as_mut().await,
        None => std::future::pending().await,
    }
}
