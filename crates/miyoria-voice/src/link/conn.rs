//! WebSocket endpoint and the per-connection loop.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use miyoria_types::{AccountRef, Event, PlatformId, PlaybackState, VoiceParticipant};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::{AudioEvent, Conn, ConnState, StreamInfo, VoiceLink, voice_context};
use crate::protocol::{
    CoreMessage, NodeMessage, TAG_CAPTURE, VERSION, WireParticipant, WirePlaybackState, close,
    decode_audio,
};

const OUT_QUEUE: usize = 256;
const MAX_MESSAGE: usize = 1 << 20;

pub(super) fn router(link: Arc<VoiceLink>) -> Router {
    Router::new()
        .route("/voice-link", get(upgrade))
        .with_state(link)
}

async fn upgrade(State(link): State<Arc<VoiceLink>>, ws: WebSocketUpgrade) -> Response {
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
fn token_matches(expected: &str, got: &str) -> bool {
    let (a, b) = (expected.as_bytes(), got.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

enum HelloOutcome {
    Ok(AccountRef, String),
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
    match serde_json::from_value::<NodeMessage>(value) {
        Ok(NodeMessage::Hello {
            version,
            node,
            self_account,
            ..
        }) => {
            if version != VERSION {
                return HelloOutcome::Reject(close::BAD_HELLO, "unsupported version");
            }
            if self_account.platform.is_empty() || self_account.id.is_empty() {
                return HelloOutcome::Reject(close::BAD_HELLO, "missing self_account");
            }
            let account = AccountRef {
                platform: PlatformId::new(self_account.platform),
                id: self_account.id,
            };
            HelloOutcome::Ok(account, node)
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
        std::time::Duration::from_secs(2),
        sink.send(close_message(code, &reason)),
    )
    .await;
}

impl VoiceLink {
    async fn serve(self: Arc<Self>, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let hello = tokio::select! {
            r = tokio::time::timeout(self.timings.hello_timeout, read_hello(&mut stream, &self.token)) => {
                r.unwrap_or(HelloOutcome::Reject(close::BAD_HELLO, "no hello in time"))
            }
            () = self.cancel.cancelled() => HelloOutcome::Reject(close::GOING_AWAY, "core shutting down"),
        };
        let (account, node) = match hello {
            HelloOutcome::Ok(account, node) => (account, node),
            HelloOutcome::Reject(code, reason) => {
                warn!(code, reason, "rejected voice node");
                let _ = sink.send(close_message(code, reason)).await;
                return;
            }
            HelloOutcome::Gone => return,
        };

        let (out_tx, out_rx) = mpsc::channel(OUT_QUEUE);
        let conn = Arc::new(Conn {
            id: self.next_conn.fetch_add(1, Ordering::Relaxed),
            account: account.clone(),
            out: out_tx,
            closed: CancellationToken::new(),
            close_frame: Mutex::new(None),
            state: Mutex::new(ConnState::default()),
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

        let replaced = {
            let mut conns = self.conns.lock();
            let old = conns
                .iter()
                .position(|c| c.account == account)
                .map(|i| conns.remove(i));
            conns.push(conn.clone());
            old
        };
        if let Some(old) = replaced {
            info!(account = %account.id, "voice node replaced by a new connection");
            old.shutdown(close::REPLACED, "replaced by a newer connection");
        }
        self.add_self_account(account.clone());
        info!(account = %account.id, %node, %session, "voice node connected");
        self.publish(Event::PlatformReady {
            platform: account.platform.clone(),
            self_account: account.clone(),
        });

        self.read_loop(&conn, &mut stream).await;
        conn.shutdown(1000, "");
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), writer).await;
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
                    warn!(account = %conn.account.id, "voice node timed out");
                    conn.shutdown(close::TIMEOUT, "heartbeat timeout");
                    return;
                }
                _ = ping.tick() => {
                    let _ = conn.out.try_send(Message::Text(CoreMessage::Ping.to_json().into()));
                }
                msg = stream.next() => {
                    let Some(Ok(msg)) = msg else { return };
                    deadline = Instant::now() + self.timings.peer_timeout;
                    match msg {
                        Message::Text(text) => match serde_json::from_str::<NodeMessage>(text.as_str()) {
                            Ok(m) => self.handle(conn, m),
                            Err(e) => warn!(error = %e, "invalid message from voice node"),
                        },
                        Message::Binary(data) => self.handle_audio(conn, &data),
                        Message::Close(_) => return,
                        Message::Ping(_) | Message::Pong(_) => {}
                    }
                }
            }
        }
    }

    fn participant(&self, platform: &PlatformId, p: WireParticipant) -> VoiceParticipant {
        let account = AccountRef {
            platform: platform.clone(),
            id: p.user_id,
        };
        let is_self = p.is_self || self.is_self(&account);
        VoiceParticipant {
            account,
            display_name: p.display_name,
            is_self,
            muted: p.muted,
            deafened: p.deafened,
        }
    }

    fn handle(&self, conn: &Arc<Conn>, msg: NodeMessage) {
        let platform = &conn.account.platform;
        match msg {
            NodeMessage::Hello { .. } => warn!("duplicate hello from voice node"),
            NodeMessage::Ping => {
                let _ = conn
                    .out
                    .try_send(Message::Text(CoreMessage::Pong.to_json().into()));
            }
            NodeMessage::Pong => {}
            NodeMessage::Joined { guild, channel } => {
                let (participants, waiting) = {
                    let mut st = conn.state.lock();
                    let g = st.guilds.entry(guild.clone()).or_default();
                    if g.channel != channel {
                        g.participants.clear();
                        g.channel.clone_from(&channel);
                    }
                    let participants = g.participants.clone();
                    let (waiting, rest) = std::mem::take(&mut st.pending_joins)
                        .into_iter()
                        .partition::<Vec<_>, _>(|p| p.guild == guild);
                    st.pending_joins = rest.into();
                    (participants, waiting)
                };
                for p in waiting {
                    let _ = p.tx.send(Ok(channel.clone()));
                }
                info!(%guild, %channel, "joined voice");
                self.publish(Event::VoiceJoined {
                    context: voice_context(platform, &guild, &channel),
                    participants,
                });
            }
            NodeMessage::Left { guild, reason } => {
                let (left, waiting) = {
                    let mut st = conn.state.lock();
                    let left = st.guilds.remove(&guild);
                    let (waiting, rest) = std::mem::take(&mut st.pending_joins)
                        .into_iter()
                        .partition::<Vec<_>, _>(|p| p.guild == guild);
                    st.pending_joins = rest.into();
                    (left, waiting)
                };
                for p in waiting {
                    let msg = format!(
                        "left voice: {}",
                        reason.as_deref().unwrap_or("no reason given")
                    );
                    let _ = p.tx.send(Err(msg));
                }
                if let Some(left) = left {
                    info!(%guild, ?reason, "left voice");
                    self.publish(Event::VoiceLeft {
                        context: voice_context(platform, &guild, &left.channel),
                        reason,
                    });
                }
            }
            NodeMessage::VoiceState {
                guild,
                channel,
                participants,
            } => {
                let participants: Vec<_> = participants
                    .into_iter()
                    .map(|p| self.participant(platform, p))
                    .collect();
                {
                    let mut st = conn.state.lock();
                    let g = st.guilds.entry(guild.clone()).or_default();
                    g.channel.clone_from(&channel);
                    g.participants.clone_from(&participants);
                }
                self.publish(Event::VoiceParticipants {
                    context: voice_context(platform, &guild, &channel),
                    participants,
                });
            }
            NodeMessage::Speaking {
                guild,
                user_id,
                speaking,
            } => {
                let channel = conn
                    .state
                    .lock()
                    .guilds
                    .get(&guild)
                    .map(|g| g.channel.clone());
                let Some(channel) = channel else {
                    debug!(%guild, "speaking signal for a guild she is not in");
                    return;
                };
                self.publish(Event::VoiceSpeaking {
                    context: voice_context(platform, &guild, &channel),
                    account: AccountRef {
                        platform: platform.clone(),
                        id: user_id,
                    },
                    speaking,
                });
            }
            NodeMessage::StreamOpen {
                stream,
                guild,
                channel,
                user_id,
                display_name,
                sample_rate,
            } => {
                let id = (conn.id << 32) | u64::from(stream);
                let previous = conn
                    .state
                    .lock()
                    .streams
                    .insert(stream, (id, guild.clone()));
                if previous.is_some() {
                    self.emit_audio(AudioEvent::StreamClose { stream: id });
                }
                self.emit_audio(AudioEvent::StreamOpen(StreamInfo {
                    stream: id,
                    context: voice_context(platform, &guild, &channel),
                    speaker: AccountRef {
                        platform: platform.clone(),
                        id: user_id,
                    },
                    display_name,
                    sample_rate,
                }));
            }
            NodeMessage::StreamClose { stream } => {
                let removed = conn.state.lock().streams.remove(&stream);
                if let Some((id, _)) = removed {
                    self.emit_audio(AudioEvent::StreamClose { stream: id });
                }
            }
            NodeMessage::Playback { play, state, error } => {
                let state = match state {
                    WirePlaybackState::Started => PlaybackState::Started,
                    WirePlaybackState::Finished => PlaybackState::Finished,
                    WirePlaybackState::Interrupted => PlaybackState::Interrupted,
                    WirePlaybackState::Failed => PlaybackState::Failed,
                };
                if let Some(error) = error {
                    warn!(play, %error, "voice node reported a playback error");
                }
                if let Some(tx) = conn.state.lock().plays.get(&play) {
                    let _ = tx.send(Some(state));
                }
            }
            NodeMessage::Error { message } => {
                warn!(%message, "voice node error");
                let pending = {
                    let mut st = conn.state.lock();
                    loop {
                        match st.pending_joins.pop_front() {
                            Some(p) if p.tx.is_closed() => {}
                            other => break other,
                        }
                    }
                };
                if let Some(p) = pending {
                    let _ = p.tx.send(Err(message));
                }
            }
        }
    }

    fn handle_audio(&self, conn: &Conn, data: &[u8]) {
        let Some((tag, stream, samples)) = decode_audio(data) else {
            return;
        };
        if tag != TAG_CAPTURE {
            debug!(tag, "unexpected binary frame from voice node");
            return;
        }
        let id = conn.state.lock().streams.get(&stream).map(|(id, _)| *id);
        if let Some(id) = id {
            self.emit_audio(AudioEvent::Frame {
                stream: id,
                samples,
            });
        }
    }

    /// Forgets a closed connection: fails its pending work and closes its
    /// streams. Guilds are reported as left unless a newer connection of the
    /// same account took over.
    fn cleanup(&self, conn: &Arc<Conn>) {
        self.conns.lock().retain(|c| c.id != conn.id);
        let state = std::mem::take(&mut *conn.state.lock());
        for (_, (id, _)) in state.streams {
            self.emit_audio(AudioEvent::StreamClose { stream: id });
        }
        let replaced = conn.close_code() == Some(close::REPLACED);
        if !replaced {
            for (guild, g) in state.guilds {
                self.publish(Event::VoiceLeft {
                    context: voice_context(&conn.account.platform, &guild, &g.channel),
                    reason: Some("voice node disconnected".to_owned()),
                });
            }
        }
        info!(account = %conn.account.id, code = ?conn.close_code(), "voice node disconnected");
        // Pending joins and plays fail when their senders drop here.
        drop(state.pending_joins);
        drop(state.plays);
    }
}
