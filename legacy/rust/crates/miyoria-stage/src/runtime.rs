//! The Stage node: `miyoria stage` on the streaming PC.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::avatar::{AvatarAction, AvatarProfile, LipSyncMode};
use crate::emotion::{EmotionController, VtsCommand};
use crate::lipsync::{Levels, LipSyncConfig, MouthShaper, serve_levels};
use crate::motion::{GazeConfig, IdleMotion, MOTION_PARAMS};
use crate::obs::{ObsConfig, ObsConnector, ObsController, ObwsConnector};
use crate::overlay::{OverlayHub, serve_overlay};
use crate::protocol::{
    CoreMessage, GazeTarget, SpeakingState, StageMessage, StageStatus, VERSION, close,
};
use crate::vts::{ApiError, ERROR_USER_DENIED, PluginInfo, VtsClient, VtsConfig, token_path};

/// Stage node config (e.g. the `[stage]` section of `miyoria.toml`).
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct StageConfig {
    /// Core's Stage Link endpoint. Default `ws://127.0.0.1:7882/stage-link`.
    pub core_url: String,
    /// Stage Link token (same as `[modules."stage.link"] token`). Required.
    pub token: String,
    /// Node name sent in `hello`. Default `stage`.
    pub node: String,
    /// Where the VTS token is stored. Default `data/stage`.
    pub data_dir: PathBuf,
    /// Overlay HTTP server address. Default `127.0.0.1:7884`.
    pub overlay_bind: String,
    /// Overlay web app files. Default `apps/overlay/dist`.
    pub overlay_dir: PathBuf,
    /// Core is considered gone after this long without traffic. Default 45 000.
    pub peer_timeout_ms: u64,
    pub vts: VtsConfig,
    pub obs: ObsConfig,
    pub lipsync: LipSyncConfig,
    pub gaze: GazeConfig,
    /// The profile's `avatar.toml` (set by the caller).
    #[serde(skip)]
    pub avatar: AvatarProfile,
}

impl Default for StageConfig {
    fn default() -> Self {
        Self {
            core_url: "ws://127.0.0.1:7882/stage-link".to_owned(),
            token: String::new(),
            node: "stage".to_owned(),
            data_dir: PathBuf::from("data/stage"),
            overlay_bind: "127.0.0.1:7884".to_owned(),
            overlay_dir: PathBuf::from("apps/overlay/dist"),
            peer_timeout_ms: 45_000,
            vts: VtsConfig::default(),
            obs: ObsConfig::default(),
            lipsync: LipSyncConfig::default(),
            gaze: GazeConfig::default(),
            avatar: AvatarProfile::default(),
        }
    }
}

/// Runs the Stage node until Ctrl-C. Fails on unusable config or when Core
/// rejects the token.
pub async fn run_stage(config: StageConfig) -> anyhow::Result<()> {
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        info!("stopping the stage");
        stop.cancel();
    });
    let obs = Arc::new(ObwsConnector::from(&config.obs));
    run_stage_with(config, obs, cancel).await
}

/// [`run_stage`] with an explicit OBS connector, until `cancel` fires.
pub async fn run_stage_with(
    config: StageConfig,
    obs_connector: Arc<dyn ObsConnector>,
    cancel: CancellationToken,
) -> anyhow::Result<()> {
    if config.token.trim().is_empty() {
        anyhow::bail!(
            "the stage token is empty: set STAGE_LINK_TOKEN (the same value as \
             `[modules.\"stage.link\"] token` on Core)"
        );
    }
    let tasks = CancellationToken::new();
    let _stop_tasks = tasks.clone().drop_guard();
    let stop = tasks.clone();
    let outer = cancel.clone();
    tokio::spawn(async move {
        outer.cancelled().await;
        stop.cancel();
    });

    let overlay = Arc::new(OverlayHub::new());
    serve_overlay(
        &config.overlay_bind,
        config.overlay_dir.clone(),
        overlay.clone(),
        tasks.clone(),
    )
    .await?;

    let levels = Arc::new(Levels::new(&config.lipsync));
    let (vts_tx, vts_rx) = watch::channel::<Option<Arc<VtsClient>>>(None);
    let (avatar_tx, avatar_rx) = mpsc::channel(64);
    if config.vts.enabled {
        if config.avatar.lipsync == LipSyncMode::Inject {
            serve_levels(&config.lipsync.bind, levels.clone(), tasks.clone()).await?;
        }
        tokio::spawn(vts_manager(
            config.vts.clone(),
            config.data_dir.clone(),
            config.avatar.clone(),
            vts_tx.clone(),
            tasks.clone(),
        ));
        let avatar = AvatarLoop {
            vts: config.vts.clone(),
            avatar: config.avatar.clone(),
            lipsync: config.lipsync.clone(),
            gaze: config.gaze.clone(),
            levels: levels.clone(),
        };
        tokio::spawn(avatar.run(vts_rx.clone(), avatar_rx, tasks.clone()));
    }
    // Kept alive so the watch stays open when VTS is disabled.
    let _vts_tx = vts_tx;

    let obs = config.obs.enabled.then(|| {
        let controller = Arc::new(ObsController::new(obs_connector, config.obs.clone()));
        tokio::spawn(controller.clone().run(tasks.clone()));
        controller
    });

    let (replies_tx, replies_rx) = mpsc::unbounded_channel();
    let stage = Arc::new(Stage {
        avatar: avatar_tx,
        vts: vts_rx,
        obs,
        overlay,
        levels,
        replies: replies_tx,
        status: watch::Sender::new(StageStatus::default()),
        core: watch::Sender::new(false),
    });
    tokio::spawn(stage.clone().aggregate_status(tasks.clone()));
    core_link(&config, stage, replies_rx, &cancel).await
}

/// Avatar-side inputs from Core.
enum AvatarInput {
    Emotion(String),
    Speaking(bool),
    Gaze(GazeTarget),
}

struct Stage {
    avatar: mpsc::Sender<AvatarInput>,
    vts: watch::Receiver<Option<Arc<VtsClient>>>,
    obs: Option<Arc<ObsController>>,
    overlay: Arc<OverlayHub>,
    levels: Arc<Levels>,
    replies: mpsc::UnboundedSender<StageMessage>,
    status: watch::Sender<StageStatus>,
    /// Connected to Core.
    core: watch::Sender<bool>,
}

impl Stage {
    fn vts_client(&self) -> Option<Arc<VtsClient>> {
        self.vts.borrow().clone().filter(|c| !c.is_closed())
    }

    fn current_status(&self) -> StageStatus {
        let obs = self.obs.as_ref().map(|o| o.state()).unwrap_or_default();
        StageStatus {
            vts: self.vts_client().is_some(),
            obs: obs.connected,
            scene: obs.scene,
            streaming: obs.streaming,
        }
    }

    fn reply(&self, id: Option<u32>, result: anyhow::Result<()>) {
        let msg = match result {
            Ok(()) => StageMessage::Status {
                status: self.current_status(),
                id,
            },
            Err(e) => StageMessage::Error {
                message: format!("{e:#}"),
                id,
            },
        };
        let _ = self.replies.send(msg);
    }

    fn obs(&self) -> anyhow::Result<Arc<ObsController>> {
        self.obs
            .clone()
            .ok_or_else(|| anyhow::anyhow!("OBS control is disabled on the stage"))
    }

    fn handle(self: &Arc<Self>, msg: CoreMessage) {
        match msg {
            CoreMessage::Emotion { name, intensity } => {
                self.overlay.emotion(&name, intensity);
                let _ = self.avatar.try_send(AvatarInput::Emotion(name));
            }
            CoreMessage::Subtitle {
                turn,
                text,
                is_final,
            } => {
                self.overlay.subtitle(&turn, &text, is_final);
                if let Some(obs) = self.obs.clone() {
                    tokio::spawn(async move { obs.subtitle(&text, is_final).await });
                }
            }
            CoreMessage::Speaking { state } => {
                self.overlay.speaking(state);
                if state == SpeakingState::Stopped {
                    self.levels.clear();
                }
                let _ = self
                    .avatar
                    .try_send(AvatarInput::Speaking(state == SpeakingState::Started));
            }
            CoreMessage::Gaze { target } => {
                let _ = self.avatar.try_send(AvatarInput::Gaze(target));
            }
            CoreMessage::Scene { name, id } => {
                let stage = self.clone();
                tokio::spawn(async move {
                    let result = match stage.obs() {
                        Ok(obs) => obs.set_scene(&name).await.map(drop),
                        Err(e) => Err(e),
                    };
                    stage.reply(id, result);
                });
            }
            CoreMessage::Stream { action, id } => {
                let stage = self.clone();
                tokio::spawn(async move {
                    let result = match stage.obs() {
                        Ok(obs) => obs.stream(action).await.map(drop),
                        Err(e) => Err(e),
                    };
                    stage.reply(id, result);
                });
            }
            CoreMessage::AvatarHotkey { name, id } => {
                let stage = self.clone();
                tokio::spawn(async move {
                    let result = match stage.vts_client() {
                        Some(vts) => vts.trigger_hotkey(&name).await.map(drop),
                        None => Err(anyhow::anyhow!("VTube Studio is not connected")),
                    };
                    stage.reply(id, result);
                });
            }
            CoreMessage::StatusRequest { id } => self.reply(id, Ok(())),
            CoreMessage::Welcome { .. } | CoreMessage::Ping | CoreMessage::Pong => {}
        }
    }

    /// Recomputes the status whenever VTS, OBS or the Core link change.
    async fn aggregate_status(self: Arc<Self>, cancel: CancellationToken) {
        let mut vts = self.vts.clone();
        let mut core = self.core.subscribe();
        let (_idle_tx, idle) = watch::channel(Default::default());
        let mut obs = self.obs.as_ref().map_or(idle, |o| o.subscribe());
        let mut last_core = None;
        loop {
            let status = self.current_status();
            let core_now = *core.borrow_and_update();
            let changed = self.status.send_if_modified(|s| {
                if *s == status {
                    false
                } else {
                    *s = status.clone();
                    true
                }
            });
            if changed || last_core != Some(core_now) {
                self.overlay.status(&status, core_now);
                last_core = Some(core_now);
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                r = vts.changed() => if r.is_err() { return },
                r = obs.changed() => if r.is_err() { return },
                r = core.changed() => if r.is_err() { return },
            }
        }
    }
}

enum SessionEnd {
    Stopped,
    Lost,
    Replaced,
}

enum SessionError {
    Fatal(anyhow::Error),
    Retry(anyhow::Error),
}

async fn core_link(
    config: &StageConfig,
    stage: Arc<Stage>,
    mut replies: mpsc::UnboundedReceiver<StageMessage>,
    cancel: &CancellationToken,
) -> anyhow::Result<()> {
    let mut backoff = Duration::from_secs(1);
    let mut failures = 0u32;
    loop {
        let outcome = session(config, &stage, &mut replies, cancel).await;
        stage.core.send_replace(false);
        match outcome {
            Ok(SessionEnd::Stopped) => return Ok(()),
            Ok(SessionEnd::Lost) => {
                warn!("lost the connection to Core, reconnecting");
                backoff = Duration::from_secs(1);
                failures = 0;
            }
            Ok(SessionEnd::Replaced) => {
                warn!("another stage node connected to Core; retrying later");
                backoff = Duration::from_secs(30);
            }
            Err(SessionError::Fatal(e)) => return Err(e),
            Err(SessionError::Retry(e)) => {
                failures += 1;
                if failures == 1 || failures % 20 == 0 {
                    warn!(error = %format!("{e:#}"), url = %config.core_url, "cannot reach Core");
                } else {
                    debug!(error = %format!("{e:#}"), "cannot reach Core");
                }
            }
        }
        tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            () = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

fn capabilities(config: &StageConfig) -> Vec<String> {
    let mut caps = vec!["overlay".to_owned()];
    if config.vts.enabled {
        caps.push("vts".to_owned());
        if config.avatar.lipsync == LipSyncMode::Inject {
            caps.push("lipsync".to_owned());
        }
    }
    if config.obs.enabled {
        caps.push("obs".to_owned());
    }
    caps
}

async fn session(
    config: &StageConfig,
    stage: &Arc<Stage>,
    replies: &mut mpsc::UnboundedReceiver<StageMessage>,
    cancel: &CancellationToken,
) -> Result<SessionEnd, SessionError> {
    let connect = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(config.core_url.as_str()),
    );
    let (ws, _) = tokio::select! {
        () = cancel.cancelled() => return Ok(SessionEnd::Stopped),
        r = connect => r
            .map_err(|_| SessionError::Retry(anyhow::anyhow!("connection timed out")))?
            .map_err(|e| SessionError::Retry(e.into()))?,
    };
    let (mut sink, mut stream) = ws.split();
    let hello = StageMessage::Hello {
        version: VERSION,
        token: config.token.trim().to_owned(),
        node: config.node.clone(),
        capabilities: capabilities(config),
    };
    let send = |text: String| Message::Text(text.into());
    sink.send(send(hello.to_json()))
        .await
        .map_err(|e| SessionError::Retry(e.into()))?;

    // Welcome, or a close frame telling why not.
    let welcome = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => {
                    match serde_json::from_str::<CoreMessage>(text.as_str()) {
                        Ok(CoreMessage::Welcome { session }) => return Ok(session),
                        _ => continue,
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame
                        .map(|f| (u16::from(f.code), f.reason.to_string()))
                        .unwrap_or((1005, String::new()));
                    let err = anyhow::anyhow!("Core closed the connection ({code}: {reason})");
                    return Err(match code {
                        close::UNAUTHORIZED => SessionError::Fatal(anyhow::anyhow!(
                            "Core rejected the stage token (check STAGE_LINK_TOKEN)"
                        )),
                        close::BAD_HELLO => SessionError::Fatal(err),
                        _ => SessionError::Retry(err),
                    });
                }
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(SessionError::Retry(e.into())),
                None => {
                    return Err(SessionError::Retry(anyhow::anyhow!(
                        "Core closed the connection"
                    )));
                }
            }
        }
    })
    .await
    .map_err(|_| SessionError::Retry(anyhow::anyhow!("no welcome from Core")))??;
    info!(session = %welcome, "connected to Core");

    // Answers meant for an earlier connection are stale.
    while replies.try_recv().is_ok() {}
    stage.core.send_replace(true);
    let mut status = stage.status.subscribe();
    let first = StageMessage::Status {
        status: stage.current_status(),
        id: None,
    };
    status.mark_unchanged();
    if sink.send(send(first.to_json())).await.is_err() {
        return Ok(SessionEnd::Lost);
    }

    let peer_timeout = Duration::from_millis(config.peer_timeout_ms.max(1));
    let mut deadline = tokio::time::Instant::now() + peer_timeout;
    loop {
        let out = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                let _ = sink.send(Message::Close(Some(tungstenite_close(1000, "stage stopping")))).await;
                return Ok(SessionEnd::Stopped);
            }
            () = tokio::time::sleep_until(deadline) => {
                warn!("Core stopped answering");
                return Ok(SessionEnd::Lost);
            }
            msg = stream.next() => {
                deadline = tokio::time::Instant::now() + peer_timeout;
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<CoreMessage>(text.as_str()) {
                            Ok(CoreMessage::Ping) => Some(StageMessage::Pong),
                            Ok(msg) => {
                                stage.handle(msg);
                                None
                            }
                            Err(e) => {
                                debug!(error = %e, "unknown message from Core");
                                None
                            }
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.map(|f| u16::from(f.code));
                        return Ok(if code == Some(close::REPLACED) {
                            SessionEnd::Replaced
                        } else {
                            SessionEnd::Lost
                        });
                    }
                    Some(Ok(_)) => None,
                    Some(Err(_)) | None => return Ok(SessionEnd::Lost),
                }
            }
            reply = replies.recv() => reply,
            r = status.changed() => {
                if r.is_err() {
                    return Ok(SessionEnd::Lost);
                }
                Some(StageMessage::Status { status: status.borrow_and_update().clone(), id: None })
            }
        };
        if let Some(out) = out {
            if sink.send(send(out.to_json())).await.is_err() {
                return Ok(SessionEnd::Lost);
            }
        }
    }
}

fn tungstenite_close(
    code: u16,
    reason: &str,
) -> tokio_tungstenite::tungstenite::protocol::CloseFrame {
    tokio_tungstenite::tungstenite::protocol::CloseFrame {
        code: CloseCode::from(code),
        reason: reason.to_owned().into(),
    }
}

/// Connects to VTube Studio and keeps the connection, reconnecting with
/// backoff.
async fn vts_manager(
    config: VtsConfig,
    data_dir: PathBuf,
    avatar: AvatarProfile,
    tx: watch::Sender<Option<Arc<VtsClient>>>,
    cancel: CancellationToken,
) {
    let plugin = PluginInfo::from(&config);
    let token_file = token_path(&data_dir);
    let timeout = Duration::from_millis(config.request_timeout_ms.max(1));
    let approval = Duration::from_millis(config.approval_timeout_ms.max(1));
    let mut backoff = Duration::from_secs(2);
    let mut failures = 0u32;
    loop {
        let attempt = async {
            let client = VtsClient::connect(&config.url, timeout).await?;
            client.authenticate(&plugin, &token_file, approval).await?;
            anyhow::Ok(Arc::new(client))
        };
        let attempt = tokio::select! {
            () = cancel.cancelled() => return,
            r = attempt => r,
        };
        match attempt {
            Ok(client) => {
                failures = 0;
                backoff = Duration::from_secs(2);
                check_model(&client, &avatar).await;
                tx.send_replace(Some(client.clone()));
                tokio::select! {
                    () = cancel.cancelled() => {
                        tx.send_replace(None);
                        return;
                    }
                    () = client.closed() => warn!("lost the VTube Studio connection"),
                }
                tx.send_replace(None);
            }
            Err(e) => {
                failures += 1;
                let denied = e
                    .downcast_ref::<ApiError>()
                    .is_some_and(|a| a.id == ERROR_USER_DENIED)
                    || format!("{e}").contains("denied");
                if denied {
                    backoff = Duration::from_secs(60);
                }
                if failures == 1 || denied || failures % 20 == 0 {
                    warn!(error = %format!("{e:#}"), "VTube Studio unavailable");
                } else {
                    debug!(error = %format!("{e:#}"), "VTube Studio unavailable");
                }
            }
        }
        tokio::select! {
            () = cancel.cancelled() => return,
            () = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

/// Warns about a different model or mappings the model does not have.
async fn check_model(client: &VtsClient, avatar: &AvatarProfile) {
    match client.current_model().await {
        Ok(model) if !model.loaded => warn!("no model loaded in VTube Studio"),
        Ok(model) => {
            info!(model = %model.name, "VTube Studio model");
            if let Some(want) = &avatar.vts_model {
                if !model.name.eq_ignore_ascii_case(want) && model.id != *want {
                    warn!(loaded = %model.name, expected = %want, "a different VTS model is loaded");
                }
            }
        }
        Err(e) => debug!(error = %e, "cannot read the current VTS model"),
    }
    if let Ok(expressions) = client.expressions().await {
        let files: HashSet<String> = expressions
            .iter()
            .map(|e| e.file.to_ascii_lowercase())
            .collect();
        for (emotion, action) in &avatar.emotions {
            if let AvatarAction::Expression(file) = action {
                if !files.contains(&file.to_ascii_lowercase()) {
                    warn!(%emotion, %file, "the model has no such expression");
                }
            }
        }
    }
    if let Ok(hotkeys) = client.hotkeys().await {
        for (emotion, action) in &avatar.emotions {
            if let AvatarAction::Hotkey(name) = action {
                if !hotkeys
                    .iter()
                    .any(|h| h.id == *name || h.name.eq_ignore_ascii_case(name))
                {
                    warn!(%emotion, hotkey = %name, "the model has no such hotkey");
                }
            }
        }
    }
}

/// Emotion, lip sync and idle motion, injected at `inject_hz`.
struct AvatarLoop {
    vts: VtsConfig,
    avatar: AvatarProfile,
    lipsync: LipSyncConfig,
    gaze: GazeConfig,
    levels: Arc<Levels>,
}

impl AvatarLoop {
    async fn run(
        self,
        mut vts: watch::Receiver<Option<Arc<VtsClient>>>,
        mut inputs: mpsc::Receiver<AvatarInput>,
        cancel: CancellationToken,
    ) {
        let mut emotion = EmotionController::new(
            &self.avatar,
            Duration::from_millis(self.vts.emotion_hold_ms),
            Duration::from_millis(self.vts.after_speech_ms),
        );
        let mut mouth = MouthShaper::new(&self.lipsync);
        let mut motion = IdleMotion::new(self.gaze.clone());
        let hz = self.vts.inject_hz.clamp(1, 120);
        let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / f64::from(hz)));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Expression / hotkey requests run in order on their own task.
        let (commands, command_rx) = mpsc::unbounded_channel::<VtsCommand>();
        tokio::spawn(run_commands(
            command_rx,
            vts.clone(),
            self.vts.expression_fade,
        ));
        let known: Arc<Mutex<Option<HashSet<String>>>> = Arc::default();
        let mut client = vts.borrow_and_update().clone();
        let mut last = Instant::now();
        let mut names: Vec<String> = Vec::new();
        let inject_mouth = self.avatar.lipsync == LipSyncMode::Inject;
        if inject_mouth {
            names.push(self.avatar.mouth_open.clone());
            if let Some(form) = &self.avatar.mouth_form {
                names.push(form.clone());
            }
        }
        if self.vts.idle_motion {
            names.extend(MOTION_PARAMS.iter().map(|s| (*s).to_owned()));
        }
        let mut values: Vec<f32> = Vec::with_capacity(names.len());
        loop {
            tokio::select! {
                () = cancel.cancelled() => return,
                r = vts.changed() => {
                    if r.is_err() {
                        return;
                    }
                    client = vts.borrow_and_update().clone();
                    *known.lock() = None;
                    if let Some(c) = client.clone() {
                        for cmd in emotion.rest() {
                            let _ = commands.send(cmd);
                        }
                        let known = known.clone();
                        let wanted = names.clone();
                        tokio::spawn(async move {
                            match c.input_parameters().await {
                                Ok(params) => {
                                    for name in wanted.iter().filter(|n| !params.contains(*n)) {
                                        warn!(parameter = %name, "VTube Studio has no such input parameter; not injecting it");
                                    }
                                    *known.lock() = Some(params);
                                }
                                Err(e) => debug!(error = %e, "cannot list VTS input parameters"),
                            }
                        });
                    }
                }
                input = inputs.recv() => {
                    let now = Instant::now();
                    match input {
                        None => return,
                        Some(AvatarInput::Emotion(name)) => {
                            for cmd in emotion.on_emotion(&name, now) {
                                let _ = commands.send(cmd);
                            }
                        }
                        Some(AvatarInput::Speaking(speaking)) => {
                            emotion.set_speaking(speaking, now);
                            if !speaking {
                                mouth.reset();
                            }
                        }
                        Some(AvatarInput::Gaze(target)) => motion.set_target(target),
                    }
                }
                _ = tick.tick() => {
                    let now = Instant::now();
                    let dt = now.saturating_duration_since(last).min(Duration::from_millis(200));
                    last = now;
                    for cmd in emotion.tick(now) {
                        let _ = commands.send(cmd);
                    }
                    values.clear();
                    if inject_mouth {
                        let m = mouth.update(self.levels.current(now), dt);
                        values.push(m.open);
                        if self.avatar.mouth_form.is_some() {
                            values.push(m.form);
                        }
                    }
                    if self.vts.idle_motion {
                        values.extend(motion.update(dt));
                    }
                    let Some(c) = client.as_ref().filter(|c| !c.is_closed()) else { continue };
                    let known = known.lock();
                    let batch: Vec<(&str, f32)> = names
                        .iter()
                        .zip(values.iter())
                        .filter(|(n, _)| known.as_ref().is_none_or(|k| k.contains(n.as_str())))
                        .map(|(n, v)| (n.as_str(), *v))
                        .collect();
                    c.inject(&batch, self.vts.face_found);
                }
            }
        }
    }
}

async fn run_commands(
    mut rx: mpsc::UnboundedReceiver<VtsCommand>,
    vts: watch::Receiver<Option<Arc<VtsClient>>>,
    fade: f32,
) {
    while let Some(cmd) = rx.recv().await {
        let Some(client) = vts.borrow().clone().filter(|c| !c.is_closed()) else {
            continue;
        };
        let result = match &cmd {
            VtsCommand::Expression { file, active } => {
                client.set_expression(file, *active, fade).await
            }
            VtsCommand::Hotkey(name) => client.trigger_hotkey(name).await.map(drop),
        };
        if let Err(e) = result {
            warn!(error = %e, ?cmd, "VTube Studio request failed");
        }
    }
}
