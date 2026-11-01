//! Module `stage.link`: the WebSocket server the Stage node connects to, and
//! the [`StageLink`] service other modules use to drive it.

pub mod commands;
mod conn;
mod forward;
mod module;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use axum::extract::ws::Message;
use miyoria_kernel::EventBus;
use miyoria_types::{Event, ModuleId};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

pub use forward::EMOTION_TOPIC;
pub use module::StageLinkModule;

use crate::protocol::{CoreMessage, GazeTarget, StageStatus, StreamAction};

/// Topic of status updates published by `stage.link`
/// (`{connected, vts, obs, scene, streaming}`).
pub const STATUS_TOPIC: &str = "stage.status";
/// Topic of errors reported by the Stage node (`{message}`).
pub const ERROR_TOPIC: &str = "stage.error";

/// `[modules."stage.link"]` config section.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct StageLinkConfig {
    /// Listen address. Default `127.0.0.1:7882`.
    pub bind: String,
    /// Shared secret the node sends in `hello`. Required.
    pub token: String,
    /// Core → node ping interval. Default 15 000.
    pub ping_interval_ms: u64,
    /// A node that sends nothing for this long is disconnected. Default 45 000.
    pub peer_timeout_ms: u64,
    /// Time allowed between connecting and `hello`. Default 5 000.
    pub hello_timeout_ms: u64,
    /// How long scene / stream / hotkey requests wait for the answer.
    /// Default 10 000.
    pub request_timeout_ms: u64,
    /// Also show replies of text (non-voice) turns as subtitles. Default false.
    pub subtitle_text_turns: bool,
}

impl Default for StageLinkConfig {
    fn default() -> Self {
        Self {
            bind: StageLinkModule::DEFAULT_BIND.to_owned(),
            token: String::new(),
            ping_interval_ms: 15_000,
            peer_timeout_ms: 45_000,
            hello_timeout_ms: 5_000,
            request_timeout_ms: 10_000,
            subtitle_text_turns: false,
        }
    }
}

pub(crate) struct Timings {
    pub ping_interval: Duration,
    pub peer_timeout: Duration,
    pub hello_timeout: Duration,
    pub request_timeout: Duration,
}

impl From<&StageLinkConfig> for Timings {
    fn from(c: &StageLinkConfig) -> Self {
        Self {
            ping_interval: Duration::from_millis(c.ping_interval_ms.max(1)),
            peer_timeout: Duration::from_millis(c.peer_timeout_ms.max(1)),
            hello_timeout: Duration::from_millis(c.hello_timeout_ms.max(1)),
            request_timeout: Duration::from_millis(c.request_timeout_ms.max(1)),
        }
    }
}

type Reply = oneshot::Sender<Result<StageStatus, String>>;

/// One authenticated Stage connection.
pub(crate) struct Conn {
    id: u64,
    node: String,
    capabilities: Vec<String>,
    out: mpsc::Sender<Message>,
    closed: CancellationToken,
    close_frame: Mutex<Option<(u16, String)>>,
    pending: Mutex<HashMap<u32, Reply>>,
}

impl Conn {
    fn try_send_json(&self, msg: &CoreMessage) -> bool {
        !self.closed.is_cancelled()
            && self
                .out
                .try_send(Message::Text(msg.to_json().into()))
                .is_ok()
    }

    /// Closes the connection with `code` (the first call wins).
    fn shutdown(&self, code: u16, reason: &str) {
        {
            let mut frame = self.close_frame.lock();
            if frame.is_none() {
                *frame = Some((code, reason.to_owned()));
            }
        }
        self.closed.cancel();
    }
}

/// Service provided by `stage.link` as `Arc<StageLink>`: the connection to
/// the Stage node (VTube Studio, OBS, overlay on the streaming PC).
pub struct StageLink {
    module: ModuleId,
    bus: EventBus,
    timings: Timings,
    cancel: CancellationToken,
    token: String,
    conn: Mutex<Option<Arc<Conn>>>,
    status: watch::Sender<Option<StageStatus>>,
    next_conn: AtomicU64,
    next_request: AtomicU32,
}

impl StageLink {
    pub(crate) fn new(
        module: ModuleId,
        bus: EventBus,
        config: &StageLinkConfig,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            module,
            bus,
            timings: Timings::from(config),
            cancel,
            token: config.token.trim().to_owned(),
            conn: Mutex::new(None),
            status: watch::Sender::new(None),
            next_conn: AtomicU64::new(1),
            next_request: AtomicU32::new(1),
        }
    }

    /// A Stage node is connected and authenticated.
    pub fn is_connected(&self) -> bool {
        self.conn.lock().is_some()
    }

    /// Name and capabilities the connected node announced.
    pub fn node(&self) -> Option<(String, Vec<String>)> {
        self.conn
            .lock()
            .as_ref()
            .map(|c| (c.node.clone(), c.capabilities.clone()))
    }

    /// Last status reported by the node; `None` while disconnected.
    pub fn status(&self) -> Option<StageStatus> {
        self.status.borrow().clone()
    }

    /// Watches the status (`None` while disconnected).
    pub fn subscribe_status(&self) -> watch::Receiver<Option<StageStatus>> {
        self.status.subscribe()
    }

    /// Switches the OBS program scene. Returns the status after the switch.
    pub async fn set_scene(&self, name: &str) -> anyhow::Result<StageStatus> {
        let name = name.trim();
        if name.is_empty() {
            anyhow::bail!("scene name is empty");
        }
        self.request(|id| CoreMessage::Scene {
            name: name.to_owned(),
            id: Some(id),
        })
        .await
    }

    /// Starts or stops streaming in OBS.
    pub async fn stream(&self, action: StreamAction) -> anyhow::Result<StageStatus> {
        self.request(|id| CoreMessage::Stream {
            action,
            id: Some(id),
        })
        .await
    }

    /// Triggers a VTube Studio hotkey by name (or id).
    pub async fn hotkey(&self, name: &str) -> anyhow::Result<StageStatus> {
        self.request(|id| CoreMessage::AvatarHotkey {
            name: name.trim().to_owned(),
            id: Some(id),
        })
        .await
    }

    /// Asks the node for a fresh status.
    pub async fn refresh_status(&self) -> anyhow::Result<StageStatus> {
        self.request(|id| CoreMessage::StatusRequest { id: Some(id) })
            .await
    }

    /// Makes her look at `target`. Fire and forget.
    pub fn gaze(&self, target: GazeTarget) -> anyhow::Result<()> {
        if self.send(&CoreMessage::Gaze { target }) {
            Ok(())
        } else {
            anyhow::bail!("stage node not connected")
        }
    }

    /// Queues a message for the node; false when none is connected or its
    /// queue is full.
    pub(crate) fn send(&self, msg: &CoreMessage) -> bool {
        let conn = self.conn.lock().clone();
        conn.is_some_and(|c| c.try_send_json(msg))
    }

    async fn request(&self, build: impl FnOnce(u32) -> CoreMessage) -> anyhow::Result<StageStatus> {
        let conn = self
            .conn
            .lock()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("stage node not connected"))?;
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        conn.pending.lock().insert(id, tx);
        let msg = build(id);
        let sent = tokio::select! {
            r = conn.out.send(Message::Text(msg.to_json().into())) => r.is_ok(),
            () = conn.closed.cancelled() => false,
        };
        if !sent {
            conn.pending.lock().remove(&id);
            anyhow::bail!("stage node disconnected");
        }
        let outcome = tokio::time::timeout(self.timings.request_timeout, rx).await;
        conn.pending.lock().remove(&id);
        match outcome {
            Ok(Ok(Ok(status))) => Ok(status),
            Ok(Ok(Err(message))) => anyhow::bail!("{message}"),
            Ok(Err(_)) => anyhow::bail!("stage node disconnected"),
            Err(_) => anyhow::bail!("stage node did not answer in time"),
        }
    }

    fn set_status(&self, status: Option<StageStatus>) {
        let changed = self.status.send_if_modified(|current| {
            if *current == status {
                false
            } else {
                current.clone_from(&status);
                true
            }
        });
        if changed {
            let payload = match &status {
                Some(s) => serde_json::json!({
                    "connected": true,
                    "vts": s.vts,
                    "obs": s.obs,
                    "scene": s.scene,
                    "streaming": s.streaming,
                }),
                None => serde_json::json!({ "connected": false }),
            };
            self.publish(Event::Custom {
                topic: STATUS_TOPIC.to_owned(),
                payload,
            });
        }
    }

    fn publish(&self, event: Event) {
        self.bus.publish(&self.module, event, None);
    }

    /// Closes the connection (module stop).
    pub(crate) fn close_all(&self) {
        if let Some(conn) = self.conn.lock().as_ref() {
            conn.shutdown(crate::protocol::close::GOING_AWAY, "core shutting down");
        }
    }
}
