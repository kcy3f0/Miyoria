//! Overlay HTTP server: `GET /overlay/ws` streams subtitle / emotion /
//! speaking / status JSON, `/overlay/` serves the overlay web app.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::{Redirect, Response};
use axum::routing::get;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tower_http::services::ServeDir;
use tracing::{debug, info, warn};

use crate::protocol::{SpeakingState, StageStatus};

#[derive(Default)]
struct Snapshot {
    status: Option<Value>,
    subtitle: Option<Value>,
    emotion: Option<Value>,
}

/// Fan-out of overlay messages. New clients first get the latest status,
/// subtitle and emotion.
pub struct OverlayHub {
    tx: broadcast::Sender<Arc<str>>,
    snapshot: Mutex<Snapshot>,
}

impl Default for OverlayHub {
    fn default() -> Self {
        Self::new()
    }
}

impl OverlayHub {
    pub fn new() -> Self {
        Self {
            tx: broadcast::channel(256).0,
            snapshot: Mutex::new(Snapshot::default()),
        }
    }

    fn send(&self, value: Value) {
        let _ = self.tx.send(value.to_string().into());
    }

    pub fn subtitle(&self, turn: &str, text: &str, is_final: bool) {
        let v = json!({ "type": "subtitle", "turn": turn, "text": text, "final": is_final });
        self.snapshot.lock().subtitle = Some(v.clone());
        self.send(v);
    }

    pub fn emotion(&self, name: &str, intensity: f32) {
        let v = json!({ "type": "emotion", "name": name, "intensity": intensity });
        self.snapshot.lock().emotion = Some(v.clone());
        self.send(v);
    }

    pub fn speaking(&self, state: SpeakingState) {
        self.send(json!({ "type": "speaking", "state": state }));
    }

    /// `core`: the Stage is connected to Core.
    pub fn status(&self, status: &StageStatus, core: bool) {
        let v = json!({
            "type": "status",
            "core": core,
            "vts": status.vts,
            "obs": status.obs,
            "scene": status.scene,
            "streaming": status.streaming,
        });
        self.snapshot.lock().status = Some(v.clone());
        self.send(v);
    }

    fn initial(&self) -> Vec<Arc<str>> {
        let s = self.snapshot.lock();
        [&s.status, &s.emotion, &s.subtitle]
            .into_iter()
            .flatten()
            .map(|v| v.to_string().into())
            .collect()
    }
}

/// Serves the overlay on `bind` until `cancel` fires.
pub async fn serve_overlay(
    bind: &str,
    dir: PathBuf,
    hub: Arc<OverlayHub>,
    cancel: CancellationToken,
) -> anyhow::Result<(SocketAddr, tokio::task::JoinHandle<anyhow::Result<()>>)> {
    let listener = TcpListener::bind(bind)
        .await
        .with_context(|| format!("cannot bind the overlay server to `{bind}`"))?;
    let addr = listener.local_addr()?;
    if !dir.is_dir() {
        warn!(dir = %dir.display(), "overlay directory not found; only /overlay/ws is served");
    }
    info!(%addr, "overlay at http://{addr}/overlay/");
    let app = Router::new()
        .route("/overlay/ws", get(upgrade))
        .with_state(hub)
        .route(
            "/overlay",
            get(|| async { Redirect::permanent("/overlay/") }),
        )
        .nest_service(
            "/overlay/",
            ServeDir::new(dir).append_index_html_on_directories(true),
        );
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(cancel.cancelled_owned())
            .await
            .context("overlay server failed")
    });
    Ok((addr, task))
}

async fn upgrade(State(hub): State<Arc<OverlayHub>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| client(socket, hub))
}

async fn client(socket: WebSocket, hub: Arc<OverlayHub>) {
    let mut rx = hub.tx.subscribe();
    let (mut sink, mut stream) = socket.split();
    for text in hub.initial() {
        if sink
            .send(Message::Text(text.as_ref().into()))
            .await
            .is_err()
        {
            return;
        }
    }
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(text) => {
                    if sink.send(Message::Text(text.as_ref().into())).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => debug!(skipped = n, "overlay client lagged"),
                Err(broadcast::error::RecvError::Closed) => return,
            },
            msg = stream.next() => match msg {
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
        }
    }
}
