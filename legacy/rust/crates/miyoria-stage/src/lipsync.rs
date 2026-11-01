//! Lip sync: playback levels from the voice node → `MouthOpen` / `MouthForm`.
//!
//! The voice node streams `{"t": <ms>, "rms": 0..1}` to
//! `ws://127.0.0.1:7883/levels` while she speaks. [`Levels`] keeps the most
//! recent samples (optionally delayed to line up with audio latency) and
//! [`MouthShaper`] turns them into smoothed mouth parameters.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use futures::StreamExt;
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

use crate::protocol::LevelFrame;

/// `[lipsync]` section of the Stage config.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct LipSyncConfig {
    /// Levels endpoint address. Default `127.0.0.1:7883`.
    pub bind: String,
    /// RMS below this counts as silence. Default 0.015.
    pub gate: f32,
    /// Mouth opening per unit of RMS above the gate. Default 5.0.
    pub gain: f32,
    /// Opening time constant. Default 35.
    pub attack_ms: f32,
    /// Closing time constant. Default 110.
    pub release_ms: f32,
    /// Largest opening (0..1). Default 1.0.
    pub max_open: f32,
    /// Resting `MouthForm`. Default 0.0.
    pub form_base: f32,
    /// How far `MouthForm` wanders while talking. Default 0.35.
    pub form_variation: f32,
    /// Delay applied to incoming levels (audio output latency). Default 0.
    pub latency_ms: u64,
    /// Without new levels for this long the mouth closes. Default 150.
    pub stale_ms: u64,
}

impl Default for LipSyncConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:7883".to_owned(),
            gate: 0.015,
            gain: 5.0,
            attack_ms: 35.0,
            release_ms: 110.0,
            max_open: 1.0,
            form_base: 0.0,
            form_variation: 0.35,
            latency_ms: 0,
            stale_ms: 150,
        }
    }
}

/// Attack / release smoothing with a noise gate and gain.
#[derive(Clone, Debug)]
pub struct Envelope {
    gate: f32,
    gain: f32,
    max: f32,
    attack: f32,
    release: f32,
    value: f32,
}

impl Envelope {
    pub fn new(config: &LipSyncConfig) -> Self {
        Self {
            gate: config.gate.max(0.0),
            gain: config.gain.max(0.0),
            max: config.max_open.clamp(0.0, 1.0),
            attack: config.attack_ms.max(1.0) / 1000.0,
            release: config.release_ms.max(1.0) / 1000.0,
            value: 0.0,
        }
    }

    /// Target opening for one RMS value, before smoothing.
    pub fn target(&self, rms: f32) -> f32 {
        if !rms.is_finite() || rms <= self.gate {
            return 0.0;
        }
        ((rms - self.gate) * self.gain).clamp(0.0, self.max)
    }

    /// Advances by `dt` towards the target of `rms`.
    pub fn update(&mut self, rms: f32, dt: Duration) -> f32 {
        let target = self.target(rms);
        let tau = if target > self.value {
            self.attack
        } else {
            self.release
        };
        let a = 1.0 - (-dt.as_secs_f32() / tau).exp();
        self.value += (target - self.value) * a;
        if self.value < 1e-3 {
            self.value = 0.0;
        }
        self.value
    }

    pub fn value(&self) -> f32 {
        self.value
    }

    pub fn reset(&mut self) {
        self.value = 0.0;
    }
}

/// Mouth parameters for one frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Mouth {
    pub open: f32,
    pub form: f32,
}

/// [`Envelope`] for the opening plus a slow wander of the mouth shape that
/// follows how open the mouth is.
#[derive(Clone, Debug)]
pub struct MouthShaper {
    envelope: Envelope,
    form_base: f32,
    form_variation: f32,
    phase: f32,
}

impl MouthShaper {
    pub fn new(config: &LipSyncConfig) -> Self {
        Self {
            envelope: Envelope::new(config),
            form_base: config.form_base.clamp(-1.0, 1.0),
            form_variation: config.form_variation.clamp(0.0, 1.0),
            phase: 0.0,
        }
    }

    pub fn update(&mut self, rms: f32, dt: Duration) -> Mouth {
        let open = self.envelope.update(rms, dt);
        // The shape changes faster while the mouth moves a lot.
        self.phase += dt.as_secs_f32() * (1.5 + 6.0 * open);
        let wander = 0.6 * (self.phase * 1.7).sin() + 0.4 * (self.phase * 4.3 + 1.0).sin();
        let form = (self.form_base + self.form_variation * wander * open.min(1.0)).clamp(-1.0, 1.0);
        Mouth { open, form }
    }

    pub fn reset(&mut self) -> Mouth {
        self.envelope.reset();
        Mouth {
            open: 0.0,
            form: self.form_base,
        }
    }
}

/// Recent level samples, shared between the levels endpoint and the
/// injection loop.
pub struct Levels {
    delay: Duration,
    stale: Duration,
    queue: Mutex<VecDeque<(Instant, f32)>>,
    last: Mutex<Option<(Instant, f32)>>,
}

impl Levels {
    pub fn new(config: &LipSyncConfig) -> Self {
        Self {
            delay: Duration::from_millis(config.latency_ms),
            stale: Duration::from_millis(config.stale_ms.max(1)),
            queue: Mutex::new(VecDeque::new()),
            last: Mutex::new(None),
        }
    }

    /// Records one sample received at `now`.
    pub fn push(&self, rms: f32, now: Instant) {
        let rms = if rms.is_finite() {
            rms.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let mut q = self.queue.lock();
        q.push_back((now + self.delay, rms));
        // About 2 s at 10 ms per sample.
        while q.len() > 200 {
            q.pop_front();
        }
    }

    /// Forgets everything (playback stopped).
    pub fn clear(&self) {
        self.queue.lock().clear();
        *self.last.lock() = None;
    }

    /// The level to show at `now`: the newest due sample, or 0 once stale.
    pub fn current(&self, now: Instant) -> f32 {
        let mut q = self.queue.lock();
        let mut last = self.last.lock();
        while let Some(&(due, rms)) = q.front() {
            if due > now {
                break;
            }
            q.pop_front();
            *last = Some((due, rms));
        }
        match *last {
            Some((at, rms)) if now.saturating_duration_since(at) <= self.stale => rms,
            _ => 0.0,
        }
    }
}

/// Serves `GET /levels` (WebSocket) on `bind` until `cancel` fires.
pub async fn serve_levels(
    bind: &str,
    levels: Arc<Levels>,
    cancel: CancellationToken,
) -> anyhow::Result<(SocketAddr, tokio::task::JoinHandle<anyhow::Result<()>>)> {
    let listener = TcpListener::bind(bind)
        .await
        .with_context(|| format!("cannot bind the lip-sync levels endpoint to `{bind}`"))?;
    let addr = listener.local_addr()?;
    info!(%addr, "lip-sync levels endpoint listening");
    let app = Router::new()
        .route("/levels", get(upgrade))
        .with_state(levels);
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(cancel.cancelled_owned())
            .await
            .context("levels server failed")
    });
    Ok((addr, task))
}

async fn upgrade(State(levels): State<Arc<Levels>>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(1 << 16)
        .on_upgrade(move |socket| read_levels(socket, levels))
}

async fn read_levels(mut socket: WebSocket, levels: Arc<Levels>) {
    debug!("levels client connected");
    while let Some(Ok(msg)) = socket.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<LevelFrame>(text.as_str()) {
                Ok(frame) => levels.push(frame.rms, Instant::now()),
                Err(e) => debug!(error = %e, "invalid level frame"),
            },
            Message::Close(_) => break,
            _ => {}
        }
    }
    debug!("levels client disconnected");
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = Duration::from_micros(16_667);

    fn config() -> LipSyncConfig {
        LipSyncConfig::default()
    }

    #[test]
    fn gate_and_gain() {
        let e = Envelope::new(&config());
        assert_eq!(e.target(0.0), 0.0);
        assert_eq!(e.target(0.01), 0.0);
        assert!((e.target(0.115) - 0.5).abs() < 1e-5);
        assert_eq!(e.target(0.9), 1.0);
        assert_eq!(e.target(f32::NAN), 0.0);
    }

    #[test]
    fn attack_is_faster_than_release() {
        let mut e = Envelope::new(&config());
        // One attack time constant reaches ~63% of the target.
        let mut v = 0.0;
        for _ in 0..2 {
            v = e.update(0.5, Duration::from_micros(17_500));
        }
        assert!((v - (1.0 - (-1.0f32).exp())).abs() < 0.01, "{v}");
        for _ in 0..30 {
            e.update(0.5, TICK);
        }
        assert!(e.value() > 0.99);
        // After one attack time constant of silence the mouth is still mostly open.
        let v = e.update(0.0, Duration::from_millis(35));
        assert!(v > 0.7, "{v}");
        for _ in 0..60 {
            e.update(0.0, TICK);
        }
        assert_eq!(e.value(), 0.0, "fully closed after silence");
    }

    #[test]
    fn mouth_form_varies_only_while_open() {
        let mut m = MouthShaper::new(&config());
        let mut forms = Vec::new();
        for _ in 0..120 {
            let mouth = m.update(0.15, TICK);
            assert!((0.0..=1.0).contains(&mouth.open));
            assert!((-1.0..=1.0).contains(&mouth.form));
            forms.push(mouth.form);
        }
        let (min, max) = forms
            .iter()
            .fold((f32::MAX, f32::MIN), |(a, b), &f| (a.min(f), b.max(f)));
        assert!(max - min > 0.1, "form varies: {min}..{max}");
        assert!(max - min <= 0.71);
        for _ in 0..120 {
            m.update(0.0, TICK);
        }
        let closed = m.update(0.0, TICK);
        assert_eq!(
            closed,
            Mouth {
                open: 0.0,
                form: 0.0
            }
        );
        assert_eq!(m.reset(), Mouth::default());
    }

    #[test]
    fn levels_go_stale_and_respect_latency() {
        let t0 = Instant::now();
        let levels = Levels::new(&config());
        assert_eq!(levels.current(t0), 0.0);
        levels.push(0.3, t0);
        levels.push(0.4, t0 + Duration::from_millis(10));
        assert_eq!(levels.current(t0 + Duration::from_millis(5)), 0.3);
        assert_eq!(levels.current(t0 + Duration::from_millis(20)), 0.4);
        assert_eq!(levels.current(t0 + Duration::from_millis(150)), 0.4);
        assert_eq!(levels.current(t0 + Duration::from_millis(200)), 0.0);
        levels.push(2.0, t0);
        assert_eq!(levels.current(t0 + Duration::from_millis(201)), 0.0);
        levels.clear();

        let delayed = Levels::new(&LipSyncConfig {
            latency_ms: 100,
            ..config()
        });
        delayed.push(0.5, t0);
        assert_eq!(delayed.current(t0 + Duration::from_millis(50)), 0.0);
        assert_eq!(delayed.current(t0 + Duration::from_millis(100)), 0.5);
        delayed.push(0.7, t0 + Duration::from_millis(100));
        delayed.clear();
        assert_eq!(delayed.current(t0 + Duration::from_millis(300)), 0.0);
    }
}
