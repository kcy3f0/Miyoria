//! OBS control (obs-websocket v5 via `obws`), behind [`Obs`] so it can be
//! faked in tests.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::protocol::StreamAction;

/// `[obs]` section of the Stage config.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct ObsConfig {
    /// Default true.
    pub enabled: bool,
    /// Default `127.0.0.1`.
    pub host: String,
    /// Default 4455.
    pub port: u16,
    /// obs-websocket password (empty when authentication is off).
    pub password: String,
    /// Text source that shows her subtitles (none by default).
    pub subtitle_source: Option<String>,
    /// Clear the subtitle source this long after the final text; 0 keeps it.
    /// Default 6 000.
    pub subtitle_clear_ms: u64,
    /// Status poll interval. Default 2 000.
    pub poll_ms: u64,
    /// How long `stream start / stop` waits for OBS to change state.
    /// Default 15 000.
    pub stream_wait_ms: u64,
}

impl Default for ObsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            host: "127.0.0.1".to_owned(),
            port: 4455,
            password: String::new(),
            subtitle_source: None,
            subtitle_clear_ms: 6_000,
            poll_ms: 2_000,
            stream_wait_ms: 15_000,
        }
    }
}

/// The OBS operations the Stage needs.
#[async_trait]
pub trait Obs: Send + Sync {
    async fn current_scene(&self) -> anyhow::Result<String>;
    async fn set_scene(&self, name: &str) -> anyhow::Result<()>;
    async fn streaming(&self) -> anyhow::Result<bool>;
    async fn start_stream(&self) -> anyhow::Result<()>;
    async fn stop_stream(&self) -> anyhow::Result<()>;
    /// Sets the `text` setting of a text source.
    async fn set_text(&self, source: &str, text: &str) -> anyhow::Result<()>;
}

/// Opens [`Obs`] connections.
#[async_trait]
pub trait ObsConnector: Send + Sync {
    async fn connect(&self) -> anyhow::Result<Arc<dyn Obs>>;
}

/// Connects with `obws`.
pub struct ObwsConnector {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
}

impl From<&ObsConfig> for ObwsConnector {
    fn from(c: &ObsConfig) -> Self {
        Self {
            host: c.host.clone(),
            port: c.port,
            password: Some(c.password.clone()).filter(|p| !p.is_empty()),
        }
    }
}

#[async_trait]
impl ObsConnector for ObwsConnector {
    async fn connect(&self) -> anyhow::Result<Arc<dyn Obs>> {
        let client = obws::Client::connect(&self.host, self.port, self.password.as_deref())
            .await
            .map_err(|e| {
                anyhow::anyhow!("cannot connect to OBS at {}:{}: {e}", self.host, self.port)
            })?;
        Ok(Arc::new(ObwsObs(client)))
    }
}

struct ObwsObs(obws::Client);

#[async_trait]
impl Obs for ObwsObs {
    async fn current_scene(&self) -> anyhow::Result<String> {
        Ok(self.0.scenes().current_program_scene().await?.id.name)
    }

    async fn set_scene(&self, name: &str) -> anyhow::Result<()> {
        Ok(self.0.scenes().set_current_program_scene(name).await?)
    }

    async fn streaming(&self) -> anyhow::Result<bool> {
        Ok(self.0.streaming().status().await?.active)
    }

    async fn start_stream(&self) -> anyhow::Result<()> {
        Ok(self.0.streaming().start().await?)
    }

    async fn stop_stream(&self) -> anyhow::Result<()> {
        Ok(self.0.streaming().stop().await?)
    }

    async fn set_text(&self, source: &str, text: &str) -> anyhow::Result<()> {
        let settings = serde_json::json!({ "text": text });
        self.0
            .inputs()
            .set_settings(obws::requests::inputs::SetSettings {
                input: obws::requests::inputs::InputId::Name(source),
                settings: &settings,
                overlay: Some(true),
            })
            .await?;
        Ok(())
    }
}

/// What the Stage knows about OBS.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ObsState {
    pub connected: bool,
    pub scene: Option<String>,
    pub streaming: bool,
}

/// Keeps one OBS connection (reconnecting with backoff), polls its state and
/// runs commands on it.
pub struct ObsController {
    connector: Arc<dyn ObsConnector>,
    config: ObsConfig,
    current: Mutex<Option<Arc<dyn Obs>>>,
    state: watch::Sender<ObsState>,
    subtitle_generation: AtomicU64,
}

impl ObsController {
    pub fn new(connector: Arc<dyn ObsConnector>, config: ObsConfig) -> Self {
        Self {
            connector,
            config,
            current: Mutex::new(None),
            state: watch::Sender::new(ObsState::default()),
            subtitle_generation: AtomicU64::new(0),
        }
    }

    pub fn state(&self) -> ObsState {
        self.state.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<ObsState> {
        self.state.subscribe()
    }

    fn obs(&self) -> anyhow::Result<Arc<dyn Obs>> {
        self.current
            .lock()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("OBS is not connected"))
    }

    /// Connection loop; returns when `cancel` fires.
    pub async fn run(self: Arc<Self>, cancel: CancellationToken) {
        let mut backoff = Duration::from_secs(1);
        let poll = Duration::from_millis(self.config.poll_ms.max(100));
        loop {
            match self.connector.connect().await {
                Ok(obs) => {
                    info!("connected to OBS");
                    backoff = Duration::from_secs(1);
                    *self.current.lock() = Some(obs);
                    loop {
                        if let Err(e) = self.refresh().await {
                            warn!(error = %e, "lost the OBS connection");
                            break;
                        }
                        tokio::select! {
                            () = cancel.cancelled() => break,
                            () = tokio::time::sleep(poll) => {}
                        }
                    }
                    *self.current.lock() = None;
                    self.state.send_replace(ObsState::default());
                }
                Err(e) => debug!(error = %e, "OBS not reachable"),
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                () = tokio::time::sleep(backoff) => {}
            }
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    /// Reads scene and streaming state.
    pub async fn refresh(&self) -> anyhow::Result<ObsState> {
        let obs = self.obs()?;
        let scene = obs.current_scene().await?;
        let streaming = obs.streaming().await?;
        let state = ObsState {
            connected: true,
            scene: Some(scene),
            streaming,
        };
        self.state.send_if_modified(|s| {
            if *s == state {
                false
            } else {
                *s = state.clone();
                true
            }
        });
        Ok(state)
    }

    pub async fn set_scene(&self, name: &str) -> anyhow::Result<ObsState> {
        self.obs()?.set_scene(name).await?;
        self.refresh().await
    }

    /// Starts / stops streaming and waits (up to `stream_wait_ms`) for OBS to
    /// report the new state.
    pub async fn stream(&self, action: StreamAction) -> anyhow::Result<ObsState> {
        let obs = self.obs()?;
        let want = action == StreamAction::Start;
        if obs.streaming().await? != want {
            match action {
                StreamAction::Start => obs.start_stream().await?,
                StreamAction::Stop => obs.stop_stream().await?,
            }
        }
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(self.config.stream_wait_ms.max(1));
        loop {
            let state = self.refresh().await?;
            if state.streaming == want || tokio::time::Instant::now() >= deadline {
                return Ok(state);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Shows `text` in the subtitle source (when configured); a final text is
    /// cleared after `subtitle_clear_ms`.
    pub async fn subtitle(self: &Arc<Self>, text: &str, is_final: bool) {
        let Some(source) = self.config.subtitle_source.clone() else {
            return;
        };
        let generation = self.subtitle_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let Ok(obs) = self.obs() else { return };
        if let Err(e) = obs.set_text(&source, text).await {
            warn!(error = %e, %source, "cannot update the subtitle source");
            return;
        }
        if is_final && self.config.subtitle_clear_ms > 0 {
            let this = self.clone();
            let delay = Duration::from_millis(self.config.subtitle_clear_ms);
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                if this.subtitle_generation.load(Ordering::Relaxed) == generation {
                    if let Ok(obs) = this.obs() {
                        let _ = obs.set_text(&source, "").await;
                    }
                }
            });
        }
    }
}
