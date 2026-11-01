//! Module `voice.link`: the WebSocket server the self voice node connects to,
//! and the [`VoiceLink`] service other modules use to drive it.

mod conn;
mod module;
mod playback;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use axum::extract::ws::Message;
use miyoria_kernel::EventBus;
use miyoria_speech::AudioStream;
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, Event, ModuleId, PlatformId, PlaybackState,
    VoiceParticipant,
};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use tracing::warn;

pub use module::VoiceLinkModule;
pub use playback::{Playback, Stoppable};

use crate::protocol::{CoreMessage, WireGoLiveState};

/// Topic of Go Live state changes (`Event::Custom`).
pub const GOLIVE_TOPIC: &str = "voice.golive";

/// `[modules."voice.link"]` config section.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct VoiceLinkConfig {
    /// Listen address. Default `127.0.0.1:7879`.
    pub bind: String,
    /// Shared secret the node sends in `hello`. Required.
    pub token: String,
    /// How long `join` waits for `joined` / `error`. Default 10 000.
    pub join_timeout_ms: u64,
    /// Core → node ping interval. Default 15 000.
    pub ping_interval_ms: u64,
    /// A node that sends nothing for this long is disconnected. Default 45 000.
    pub peer_timeout_ms: u64,
    /// Time allowed between connecting and `hello`. Default 5 000.
    pub hello_timeout_ms: u64,
    /// Capacity of each audio subscriber channel, in events. Default 1024
    /// (about 20 s of one 20 ms stream).
    pub audio_buffer: usize,
}

impl Default for VoiceLinkConfig {
    fn default() -> Self {
        Self {
            bind: VoiceLinkModule::DEFAULT_BIND.to_owned(),
            token: String::new(),
            join_timeout_ms: 10_000,
            ping_interval_ms: 15_000,
            peer_timeout_ms: 45_000,
            hello_timeout_ms: 5_000,
            audio_buffer: 1024,
        }
    }
}

/// Information about one incoming audio stream (one speaker).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamInfo {
    /// Unique per link (node stream ids are scoped to their connection).
    pub stream: u64,
    /// `ContextKind::Voice`; scope = guild, channel = voice channel.
    pub context: ContextKey,
    pub speaker: AccountRef,
    pub display_name: String,
    pub sample_rate: u32,
}

/// Captured audio, as delivered by [`VoiceLink::subscribe_audio`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AudioEvent {
    StreamOpen(StreamInfo),
    /// PCM s16le mono at the stream's sample rate (16 kHz).
    Frame {
        stream: u64,
        samples: Vec<i16>,
    },
    StreamClose {
        stream: u64,
    },
}

/// Go Live state, as reported by the voice node.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GoLiveState {
    /// Waiting for the source, connecting to Discord.
    Starting,
    /// Frames are being sent to Discord.
    Live,
    /// Ended (stop request, source ended, left voice).
    Stopped,
    /// Could not start, or died; see [`GoLiveStatus::error`].
    Failed,
}

impl From<WireGoLiveState> for GoLiveState {
    fn from(s: WireGoLiveState) -> Self {
        match s {
            WireGoLiveState::Starting => Self::Starting,
            WireGoLiveState::Live => Self::Live,
            WireGoLiveState::Stopped => Self::Stopped,
            WireGoLiveState::Failed => Self::Failed,
        }
    }
}

/// Last Go Live state of one guild.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoLiveStatus {
    pub state: GoLiveState,
    /// Why it failed (`Failed`).
    pub error: Option<String>,
    /// Why it ended (`Stopped`), e.g. "source ended".
    pub reason: Option<String>,
}

/// A request to start a Go Live stream. Only `guild` and `source` are
/// required; the node applies its own defaults to the rest.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GoLiveRequest {
    pub guild: String,
    /// Voice channel to stream in. Default: the one she is in, else the node
    /// joins it first.
    pub channel: Option<String>,
    /// `rtmp://`, `srt://`, `udp://`, `http(s)://` URL or a local file.
    pub source: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub bitrate_kbps: Option<u32>,
    /// `auto` (default), `nvenc` or `software`.
    pub encoder: Option<String>,
    /// Send the source's audio track (default true).
    pub audio: Option<bool>,
    /// Make the node's ffmpeg wait for the source to connect (default: true
    /// for `rtmp://`; SRT URLs without `mode=` become `mode=listener`).
    pub listen: Option<bool>,
}

/// Builds the context of a voice channel.
pub fn voice_context(platform: &PlatformId, guild: &str, channel: &str) -> ContextKey {
    ContextKey {
        platform: platform.clone(),
        scope: Some(guild.to_owned()),
        channel: channel.to_owned(),
        kind: ContextKind::Voice,
    }
}

pub(crate) struct Timings {
    pub join_timeout: Duration,
    pub ping_interval: Duration,
    pub peer_timeout: Duration,
    pub hello_timeout: Duration,
}

impl From<&VoiceLinkConfig> for Timings {
    fn from(c: &VoiceLinkConfig) -> Self {
        Self {
            join_timeout: Duration::from_millis(c.join_timeout_ms.max(1)),
            ping_interval: Duration::from_millis(c.ping_interval_ms.max(1)),
            peer_timeout: Duration::from_millis(c.peer_timeout_ms.max(1)),
            hello_timeout: Duration::from_millis(c.hello_timeout_ms.max(1)),
        }
    }
}

#[derive(Default)]
struct GuildState {
    channel: String,
    participants: Vec<VoiceParticipant>,
}

struct PendingJoin {
    guild: String,
    tx: oneshot::Sender<Result<String, String>>,
}

#[derive(Default)]
struct ConnState {
    guilds: HashMap<String, GuildState>,
    pending_joins: VecDeque<PendingJoin>,
    /// Playback state reported by the node, per play id.
    plays: HashMap<u32, watch::Sender<Option<PlaybackState>>>,
    /// Node stream id → (link stream id, guild).
    streams: HashMap<u32, (u64, String)>,
    /// Go Live state reported by the node, per guild.
    golive: HashMap<String, GoLiveStatus>,
}

/// One authenticated node connection.
pub(crate) struct Conn {
    id: u64,
    account: AccountRef,
    out: mpsc::Sender<Message>,
    closed: CancellationToken,
    close_frame: Mutex<Option<(u16, String)>>,
    state: Mutex<ConnState>,
}

impl Conn {
    /// Queues a message; fails once the connection is closing.
    async fn send(&self, msg: Message) -> anyhow::Result<()> {
        tokio::select! {
            r = self.out.send(msg) => r.map_err(|_| anyhow::anyhow!("voice node disconnected")),
            () = self.closed.cancelled() => anyhow::bail!("voice node disconnected"),
        }
    }

    async fn send_json(&self, msg: &CoreMessage) -> anyhow::Result<()> {
        self.send(Message::Text(msg.to_json().into())).await
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

    fn close_code(&self) -> Option<u16> {
        self.close_frame.lock().as_ref().map(|(c, _)| *c)
    }
}

/// Service provided by `voice.link` as `Arc<VoiceLink>`: the connection to
/// the self voice node(s), one per self account.
///
/// Commands go to the connection that is in the given guild, else to the most
/// recently connected one.
pub struct VoiceLink {
    module: ModuleId,
    bus: EventBus,
    timings: Timings,
    cancel: CancellationToken,
    token: String,
    audio_buffer: usize,
    conns: Mutex<Vec<Arc<Conn>>>,
    audio_subs: Mutex<Vec<mpsc::Sender<AudioEvent>>>,
    audio_dropped: AtomicU64,
    known_self: Mutex<HashSet<AccountRef>>,
    next_conn: AtomicU64,
    next_play: AtomicU32,
}

impl VoiceLink {
    pub(crate) fn new(
        module: ModuleId,
        bus: EventBus,
        config: &VoiceLinkConfig,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            module,
            bus,
            timings: Timings::from(config),
            cancel,
            token: config.token.trim().to_owned(),
            audio_buffer: config.audio_buffer.max(1),
            conns: Mutex::new(Vec::new()),
            audio_subs: Mutex::new(Vec::new()),
            audio_dropped: AtomicU64::new(0),
            known_self: Mutex::new(HashSet::new()),
            next_conn: AtomicU64::new(1),
            next_play: AtomicU32::new(1),
        }
    }

    /// A voice node is connected and authenticated.
    pub fn is_connected(&self) -> bool {
        !self.conns.lock().is_empty()
    }

    /// The self account of the most recently connected node.
    pub fn self_account(&self) -> Option<AccountRef> {
        self.conns.lock().last().map(|c| c.account.clone())
    }

    /// Whether `account` is one of her accounts (a connected node's self
    /// account, or any account announced with `PlatformReady`).
    pub fn is_self(&self, account: &AccountRef) -> bool {
        let known = self.known_self.lock().contains(account);
        known || self.conns.lock().iter().any(|c| &c.account == account)
    }

    pub(crate) fn add_self_account(&self, account: AccountRef) {
        self.known_self.lock().insert(account);
    }

    fn conn_for(&self, guild: &str) -> Option<Arc<Conn>> {
        let conns = self.conns.lock();
        conns
            .iter()
            .rev()
            .find(|c| c.state.lock().guilds.contains_key(guild))
            .or_else(|| conns.last())
            .cloned()
    }

    /// Joins voice in `guild`: `channel` if given, else the channel `user_id`
    /// is currently in. Returns the joined channel id.
    pub async fn join(
        &self,
        guild: &str,
        channel: Option<&str>,
        user_id: Option<&str>,
    ) -> anyhow::Result<String> {
        if channel.is_none() && user_id.is_none() {
            anyhow::bail!("join needs a channel or a user id");
        }
        let conn = self
            .conn_for(guild)
            .ok_or_else(|| anyhow::anyhow!("no voice node connected"))?;
        let (tx, rx) = oneshot::channel();
        conn.state.lock().pending_joins.push_back(PendingJoin {
            guild: guild.to_owned(),
            tx,
        });
        conn.send_json(&CoreMessage::Join {
            guild: guild.to_owned(),
            channel: channel.map(str::to_owned),
            user_id: user_id.map(str::to_owned),
        })
        .await?;
        match tokio::time::timeout(self.timings.join_timeout, rx).await {
            Ok(Ok(Ok(channel))) => Ok(channel),
            Ok(Ok(Err(message))) => anyhow::bail!("{message}"),
            Ok(Err(_)) => anyhow::bail!("voice node disconnected"),
            Err(_) => anyhow::bail!("voice node did not answer the join in time"),
        }
    }

    /// Leaves voice in `guild`. `VoiceLeft` follows when the node confirms.
    pub async fn leave(&self, guild: &str) -> anyhow::Result<()> {
        let conn = self
            .conn_for(guild)
            .ok_or_else(|| anyhow::anyhow!("no voice node connected"))?;
        conn.send_json(&CoreMessage::Leave {
            guild: guild.to_owned(),
        })
        .await
    }

    /// The voice channel she is in, in `guild`.
    pub fn channel(&self, guild: &str) -> Option<String> {
        self.conns
            .lock()
            .iter()
            .rev()
            .find_map(|c| c.state.lock().guilds.get(guild).map(|g| g.channel.clone()))
    }

    /// Who is in her voice channel in `guild` (empty when she is not in one).
    pub fn participants(&self, guild: &str) -> Vec<VoiceParticipant> {
        self.conns
            .lock()
            .iter()
            .rev()
            .find_map(|c| {
                c.state
                    .lock()
                    .guilds
                    .get(guild)
                    .map(|g| g.participants.clone())
            })
            .unwrap_or_default()
    }

    /// Starts playing `audio` (PCM s16le mono at `sample_rate`) in `guild`.
    /// The node queues plays, so this returns before the audio is heard.
    pub async fn play(
        &self,
        guild: &str,
        sample_rate: u32,
        audio: AudioStream,
    ) -> anyhow::Result<Playback> {
        if sample_rate == 0 {
            anyhow::bail!("sample rate must not be 0");
        }
        let conn = self
            .conn_for(guild)
            .ok_or_else(|| anyhow::anyhow!("no voice node connected"))?;
        let id = self.next_play.fetch_add(1, Ordering::Relaxed);
        let (node_tx, node_rx) = watch::channel(None);
        conn.state.lock().plays.insert(id, node_tx);
        let start = CoreMessage::PlayStart {
            play: id,
            guild: guild.to_owned(),
            sample_rate,
        };
        if let Err(e) = conn.send_json(&start).await {
            conn.state.lock().plays.remove(&id);
            return Err(e);
        }
        Ok(playback::spawn(conn, id, sample_rate, audio, node_rx))
    }

    /// Asks the node to start a Go Live stream. Returns once the request is
    /// sent; progress arrives as `voice.golive` events (`starting`, `live`,
    /// `stopped`, `failed`) and in [`VoiceLink::golive`].
    pub async fn golive_start(&self, req: GoLiveRequest) -> anyhow::Result<()> {
        if req.guild.trim().is_empty() {
            anyhow::bail!("go live needs a guild");
        }
        if req.source.trim().is_empty() {
            anyhow::bail!("go live needs a source");
        }
        if let Some(e) = req.encoder.as_deref()
            && !matches!(e, "auto" | "nvenc" | "software")
        {
            anyhow::bail!("unknown encoder `{e}` (expected auto, nvenc or software)");
        }
        for (name, v) in [
            ("width", req.width),
            ("height", req.height),
            ("fps", req.fps),
            ("bitrate_kbps", req.bitrate_kbps),
        ] {
            if v == Some(0) {
                anyhow::bail!("`{name}` must not be 0");
            }
        }
        let conn = self
            .conn_for(&req.guild)
            .ok_or_else(|| anyhow::anyhow!("no voice node connected"))?;
        conn.send_json(&CoreMessage::GoliveStart {
            guild: req.guild,
            channel: req.channel,
            source: req.source.trim().to_owned(),
            width: req.width,
            height: req.height,
            fps: req.fps,
            bitrate_kbps: req.bitrate_kbps,
            encoder: req.encoder,
            audio: req.audio,
            listen: req.listen,
        })
        .await
    }

    /// Asks the node to stop the Go Live stream in `guild`.
    pub async fn golive_stop(&self, guild: &str) -> anyhow::Result<()> {
        let conn = self
            .conn_for(guild)
            .ok_or_else(|| anyhow::anyhow!("no voice node connected"))?;
        conn.send_json(&CoreMessage::GoliveStop {
            guild: guild.to_owned(),
        })
        .await
    }

    /// The last Go Live state the node reported for `guild`.
    pub fn golive(&self, guild: &str) -> Option<GoLiveStatus> {
        self.conns
            .lock()
            .iter()
            .rev()
            .find_map(|c| c.state.lock().golive.get(guild).cloned())
    }

    /// Whether a Go Live stream is starting or live in `guild`.
    pub fn is_streaming(&self, guild: &str) -> bool {
        self.golive(guild)
            .is_some_and(|s| matches!(s.state, GoLiveState::Starting | GoLiveState::Live))
    }

    fn publish_golive(&self, platform: &PlatformId, guild: &str, status: &GoLiveStatus) {
        self.publish(Event::Custom {
            topic: GOLIVE_TOPIC.to_owned(),
            payload: serde_json::json!({
                "platform": platform.as_str(),
                "guild": guild,
                "state": status.state,
                "error": status.error,
                "reason": status.reason,
            }),
        });
    }

    /// Receives every captured audio event from now on. The channel is
    /// bounded; events are dropped (with a warning) while it is full.
    pub fn subscribe_audio(&self) -> mpsc::Receiver<AudioEvent> {
        let (tx, rx) = mpsc::channel(self.audio_buffer);
        self.audio_subs.lock().push(tx);
        rx
    }

    fn emit_audio(&self, event: AudioEvent) {
        let mut subs = self.audio_subs.lock();
        subs.retain(|tx| match tx.try_send(event.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                let n = self.audio_dropped.fetch_add(1, Ordering::Relaxed);
                if n % 100 == 0 {
                    warn!(dropped = n + 1, "audio subscriber is full, dropping events");
                }
                true
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
    }

    fn publish(&self, event: Event) {
        self.bus.publish(&self.module, event, None);
    }

    /// Closes every connection (module stop).
    pub(crate) fn close_all(&self) {
        for conn in self.conns.lock().iter() {
            conn.shutdown(crate::protocol::close::GOING_AWAY, "core shutting down");
        }
    }
}
