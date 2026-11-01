//! Turn coordinator: one per conversation context.
//!
//! Debounces incoming messages into turns, keeps at most one turn in flight
//! and restarts the turn when new input arrives before its reply was submitted.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use miyoria_types::{ActionSink, ContextKey, Event, IncomingMessage, TurnId};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::debug;

use crate::runtime::{Agent, Input};
use crate::session::Session;
use crate::turn;

struct Running {
    turn: TurnId,
    inputs: Vec<IncomingMessage>,
    /// Set once the reply has been handed to the scheduler.
    submitted: Arc<AtomicBool>,
    fut: BoxFuture<'static, ()>,
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
        let mut pending: Vec<IncomingMessage> = Vec::new();
        let mut window: Option<Window> = None;
        let mut running: Option<Running> = None;
        loop {
            let deadline = window.map(|w| w.deadline);
            let idle = pending.is_empty() && running.is_none();
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
                    return Ok(());
                }
                Wake::Input(Input::Message(msg)) => {
                    if running
                        .as_ref()
                        .is_some_and(|r| !r.submitted.load(Ordering::SeqCst))
                    {
                        let r = running.take().expect("checked above");
                        let mut merged = self.abort(r).await;
                        merged.append(&mut pending);
                        pending = merged;
                        window = None;
                    }
                    pending.push(*msg);
                    let opened = window.map_or(now, |w| w.opened);
                    window = Some(Window {
                        opened,
                        deadline: (now + cfg.debounce()).min(opened + cfg.max_debounce()),
                    });
                }
                Wake::Input(Input::Typing) => {
                    if let Some(w) = &mut window {
                        w.deadline = w
                            .deadline
                            .max(now + cfg.typing_extend())
                            .min(w.opened + cfg.max_debounce());
                    }
                }
                Wake::Deadline => {
                    window = None;
                    running = Some(self.start(std::mem::take(&mut pending)));
                }
                Wake::TurnDone => running = None,
                Wake::Idle => {
                    if self.agent.retire(&self.key, &self.rx) {
                        debug!(context = %self.key, "context idle, session dropped");
                        return Ok(());
                    }
                }
            }
        }
    }

    fn start(&self, inputs: Vec<IncomingMessage>) -> Running {
        let turn = TurnId::new();
        self.agent.ctx.publish_in_turn(
            Event::AgentTurnStarted {
                turn,
                context: self.key.clone(),
            },
            turn,
        );
        let submitted = Arc::new(AtomicBool::new(false));
        let fut = turn::run(
            self.agent.clone(),
            self.key.clone(),
            self.session.clone(),
            turn,
            inputs.clone(),
            submitted.clone(),
        );
        Running {
            turn,
            inputs,
            submitted,
            fut: Box::pin(fut),
        }
    }

    /// Cancels a turn whose reply was not submitted yet; returns its inputs.
    async fn abort(&self, running: Running) -> Vec<IncomingMessage> {
        let Running {
            turn, inputs, fut, ..
        } = running;
        drop(fut);
        debug!(%turn, context = %self.key, "turn cancelled by new input");
        if let Some(sink) = self.agent.ctx.services().get::<dyn ActionSink>() {
            let _ = sink.cancel_turn(turn).await;
        }
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
