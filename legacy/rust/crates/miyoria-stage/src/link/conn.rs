//! WebSocket endpoint and the per-connection loop.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use miyoria_types::Event;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::{Conn, ERROR_TOPIC, StageLink};
use crate::protocol::{CoreMessage, StageMessage, VERSION, close};

const OUT_QUEUE: usize = 256;
const MAX_MESSAGE: usize = 1 << 16;

pub(super) fn router(link: Arc<StageLink>) -> Router {
    Router::new()
        .route("/stage-link", get(upgrade))
        .with_state(link)
}

async fn upgrade(State(link): State<Arc<StageLink>>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| async move { link.serve(socket).await })
}

fn close_message(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

/// Constant-time comparison of the token.
pub(crate) fn token_matches(expected: &str, got: &str) -> bool {
    let (a, b) = (expected.as_bytes(), got.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

enum HelloOutcome {
    Ok(String, Vec<String>),
    Reject(u16, &'static str),
    Gone,
}

async fn read_hello(stream: &mut SplitStream<WebSocket>, token: &str) -> HelloOutcome {
    let text = loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => break text,
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Ok(Message::Binary(_))) => {
                return HelloOutcome::Reject(close::BAD_HELLO, "expected hello");
            }
            Some(Ok(Message::Close(_)) | Err(_)) | None => return HelloOutcome::Gone,
        }
    };
    let value: serde_json::Value = match serde_json::from_str(text.as_str()) {
        Ok(v) => v,
        Err(_) => return HelloOutcome::Reject(close::BAD_HELLO, "invalid JSON"),
    };
    if value.get("type").and_then(|t| t.as_str()) != Some("hello") {
        return HelloOutcome::Reject(close::BAD_HELLO, "expected hello");
    }
    // Token first, so an unauthenticated peer learns nothing else.
    let got = value.get("token").and_then(|t| t.as_str()).unwrap_or("");
    if !token_matches(token, got) {
        return HelloOutcome::Reject(close::UNAUTHORIZED, "invalid token");
    }
    match serde_json::from_value::<StageMessage>(value) {
        Ok(StageMessage::Hello {
            version,
            node,
            capabilities,
            ..
        }) => {
            if version != VERSION {
                return HelloOutcome::Reject(close::BAD_HELLO, "unsupported version");
            }
            HelloOutcome::Ok(node, capabilities)
        }
        _ => HelloOutcome::Reject(close::BAD_HELLO, "malformed hello"),
    }
}

/// Forwards queued messages to the socket until the connection closes, then
/// sends the close frame.
async fn write_loop(
    mut sink: SplitSink<WebSocket, Message>,
    mut rx: mpsc::Receiver<Message>,
    conn: Arc<Conn>,
) {
    loop {
        tokio::select! {
            biased;
            () = conn.closed.cancelled() => break,
            msg = rx.recv() => match msg {
                Some(msg) => {
                    if sink.send(msg).await.is_err() {
                        conn.shutdown(1006, "write failed");
                        return;
                    }
                }
                None => break,
            },
        }
    }
    let (code, reason) = conn
        .close_frame
        .lock()
        .clone()
        .unwrap_or((1000, String::new()));
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        sink.send(close_message(code, &reason)),
    )
    .await;
}

impl StageLink {
    async fn serve(self: Arc<Self>, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let hello = tokio::select! {
            r = tokio::time::timeout(self.timings.hello_timeout, read_hello(&mut stream, &self.token)) => {
                r.unwrap_or(HelloOutcome::Reject(close::BAD_HELLO, "no hello in time"))
            }
            () = self.cancel.cancelled() => HelloOutcome::Reject(close::GOING_AWAY, "core shutting down"),
        };
        let (node, capabilities) = match hello {
            HelloOutcome::Ok(node, capabilities) => (node, capabilities),
            HelloOutcome::Reject(code, reason) => {
                warn!(code, reason, "rejected stage node");
                let _ = sink.send(close_message(code, reason)).await;
                return;
            }
            HelloOutcome::Gone => return,
        };

        let (out_tx, out_rx) = mpsc::channel(OUT_QUEUE);
        let conn = Arc::new(Conn {
            id: self.next_conn.fetch_add(1, Ordering::Relaxed),
            node: node.clone(),
            capabilities: capabilities.clone(),
            out: out_tx,
            closed: CancellationToken::new(),
            close_frame: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        });
        let session = ulid::Ulid::new().to_string();
        // Welcome goes out before anything else on this connection.
        let _ = conn.out.try_send(Message::Text(
            CoreMessage::Welcome {
                session: session.clone(),
            }
            .to_json()
            .into(),
        ));
        let writer = tokio::spawn(write_loop(sink, out_rx, conn.clone()));

        let replaced = self.conn.lock().replace(conn.clone());
        if let Some(old) = replaced {
            info!("stage node replaced by a new connection");
            old.shutdown(close::REPLACED, "replaced by a newer connection");
        }
        info!(%node, ?capabilities, %session, "stage node connected");
        // Until the node reports, everything is assumed down.
        self.set_status(Some(Default::default()));

        self.read_loop(&conn, &mut stream).await;
        conn.shutdown(1000, "");
        let _ = tokio::time::timeout(Duration::from_secs(3), writer).await;
        self.cleanup(&conn);
    }

    async fn read_loop(&self, conn: &Arc<Conn>, stream: &mut SplitStream<WebSocket>) {
        let mut deadline = Instant::now() + self.timings.peer_timeout;
        let mut ping = tokio::time::interval_at(
            Instant::now() + self.timings.ping_interval,
            self.timings.ping_interval,
        );
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                () = self.cancel.cancelled() => {
                    conn.shutdown(close::GOING_AWAY, "core shutting down");
                    return;
                }
                () = conn.closed.cancelled() => return,
                () = sleep_until(deadline) => {
                    warn!("stage node timed out");
                    conn.shutdown(close::TIMEOUT, "heartbeat timeout");
                    return;
                }
                _ = ping.tick() => {
                    conn.try_send_json(&CoreMessage::Ping);
                }
                msg = stream.next() => {
                    let Some(Ok(msg)) = msg else { return };
                    deadline = Instant::now() + self.timings.peer_timeout;
                    match msg {
                        Message::Text(text) => match serde_json::from_str::<StageMessage>(text.as_str()) {
                            Ok(m) => self.handle(conn, m),
                            Err(e) => warn!(error = %e, "invalid message from stage node"),
                        },
                        Message::Close(_) => return,
                        Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => {}
                    }
                }
            }
        }
    }

    fn is_current(&self, conn: &Arc<Conn>) -> bool {
        self.conn.lock().as_ref().is_some_and(|c| c.id == conn.id)
    }

    fn handle(&self, conn: &Arc<Conn>, msg: StageMessage) {
        match msg {
            StageMessage::Hello { .. } => warn!("duplicate hello from stage node"),
            StageMessage::Ping => {
                conn.try_send_json(&CoreMessage::Pong);
            }
            StageMessage::Pong => {}
            StageMessage::Status { status, id } => {
                if self.is_current(conn) {
                    self.set_status(Some(status.clone()));
                }
                if let Some(tx) = id.and_then(|id| conn.pending.lock().remove(&id)) {
                    let _ = tx.send(Ok(status));
                }
            }
            StageMessage::Error { message, id } => {
                warn!(%message, ?id, "stage node error");
                if let Some(tx) = id.and_then(|id| conn.pending.lock().remove(&id)) {
                    let _ = tx.send(Err(message.clone()));
                }
                self.publish(Event::Custom {
                    topic: ERROR_TOPIC.to_owned(),
                    payload: serde_json::json!({ "message": message }),
                });
            }
        }
    }

    /// Forgets a closed connection; its pending requests fail.
    fn cleanup(&self, conn: &Arc<Conn>) {
        let current = {
            let mut slot = self.conn.lock();
            if slot.as_ref().is_some_and(|c| c.id == conn.id) {
                *slot = None;
                true
            } else {
                false
            }
        };
        conn.pending.lock().clear();
        if current {
            self.set_status(None);
        }
        let code = conn.close_frame.lock().as_ref().map(|(c, _)| *c);
        info!(?code, "stage node disconnected");
    }
}
