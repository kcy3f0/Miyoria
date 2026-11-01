use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::extract::ws::Message;
use futures::StreamExt;
use miyoria_speech::AudioStream;
use miyoria_types::PlaybackState;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use super::Conn;
use crate::protocol::{CoreMessage, TAG_PLAYBACK, encode_audio};

/// Something that is playing and can be cut short (used by barge-in).
pub trait Stoppable: Send + Sync {
    fn stop(&self, fade_ms: u32);
}

/// Handle of one playback started with [`VoiceLink::play`](super::VoiceLink::play).
/// Cheap to clone.
#[derive(Clone)]
pub struct Playback {
    id: u32,
    stop: CancellationToken,
    fade_ms: Arc<AtomicU32>,
    state: watch::Receiver<Option<PlaybackState>>,
}

impl Playback {
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Stops the playback, fading out over `fade_ms`. It then ends as
    /// [`PlaybackState::Interrupted`] (unless it already ended).
    pub fn stop(&self, fade_ms: u32) {
        if !self.stop.is_cancelled() {
            self.fade_ms.store(fade_ms, Ordering::Relaxed);
        }
        self.stop.cancel();
    }

    /// The latest state: `None` until the node reports `started`.
    pub fn state(&self) -> Option<PlaybackState> {
        *self.state.borrow()
    }

    /// Waits until the playback finished, was interrupted or failed.
    pub async fn wait(&self) -> PlaybackState {
        let mut rx = self.state.clone();
        match rx
            .wait_for(|s| s.is_some_and(|s| s != PlaybackState::Started))
            .await
        {
            Ok(s) => s.unwrap_or(PlaybackState::Failed),
            Err(_) => PlaybackState::Failed,
        }
    }
}

impl Stoppable for Playback {
    fn stop(&self, fade_ms: u32) {
        Playback::stop(self, fade_ms);
    }
}

/// Starts the task that streams `audio` to the node. `play_start` has
/// already been sent.
pub(super) fn spawn(
    conn: Arc<Conn>,
    id: u32,
    sample_rate: u32,
    audio: AudioStream,
    node: watch::Receiver<Option<PlaybackState>>,
) -> Playback {
    let stop = CancellationToken::new();
    let fade_ms = Arc::new(AtomicU32::new(0));
    let (state_tx, state_rx) = watch::channel(None);
    let playback = Playback {
        id,
        stop: stop.clone(),
        fade_ms: fade_ms.clone(),
        state: state_rx,
    };
    tokio::spawn(async move {
        let end = pump(
            &conn,
            id,
            sample_rate,
            audio,
            &stop,
            &fade_ms,
            node,
            &state_tx,
        )
        .await;
        conn.state.lock().plays.remove(&id);
        debug!(play = id, state = ?end, "playback ended");
        let _ = state_tx.send(Some(end));
    });
    playback
}

enum Step {
    Continue,
    End(PlaybackState),
}

#[allow(clippy::too_many_arguments)]
async fn pump(
    conn: &Conn,
    id: u32,
    sample_rate: u32,
    mut audio: AudioStream,
    stop: &CancellationToken,
    fade_ms: &AtomicU32,
    mut node: watch::Receiver<Option<PlaybackState>>,
    state: &watch::Sender<Option<PlaybackState>>,
) -> PlaybackState {
    // 100 ms frames keep play_stop responsive without flooding the socket.
    let frame_len = usize::try_from(sample_rate / 10).unwrap_or(1).max(1);
    let mut sending = true;
    loop {
        let step = tokio::select! {
            biased;
            () = stop.cancelled() => {
                let fade_ms = fade_ms.load(Ordering::Relaxed);
                let _ = conn.send_json(&CoreMessage::PlayStop { play: id, fade_ms }).await;
                Step::End(PlaybackState::Interrupted)
            }
            () = conn.closed.cancelled() => Step::End(PlaybackState::Failed),
            changed = node.changed() => match changed {
                Err(_) => Step::End(PlaybackState::Failed),
                Ok(()) => match *node.borrow_and_update() {
                    Some(PlaybackState::Started) => {
                        let _ = state.send(Some(PlaybackState::Started));
                        Step::Continue
                    }
                    Some(end) => Step::End(end),
                    None => Step::Continue,
                },
            },
            chunk = audio.next(), if sending => match chunk {
                Some(Ok(chunk)) if chunk.sample_rate != sample_rate => {
                    warn!(play = id, expected = sample_rate, got = chunk.sample_rate, "audio chunk has a different sample rate");
                    let _ = conn.send_json(&CoreMessage::PlayStop { play: id, fade_ms: 0 }).await;
                    Step::End(PlaybackState::Failed)
                }
                Some(Ok(chunk)) => {
                    let mut step = Step::Continue;
                    for frame in chunk.samples.chunks(frame_len) {
                        let bytes = encode_audio(TAG_PLAYBACK, id, frame);
                        if conn.send(Message::Binary(bytes.into())).await.is_err() {
                            step = Step::End(PlaybackState::Failed);
                            break;
                        }
                    }
                    step
                }
                Some(Err(e)) => {
                    warn!(play = id, error = %e, "audio stream failed");
                    let _ = conn.send_json(&CoreMessage::PlayStop { play: id, fade_ms: 0 }).await;
                    Step::End(PlaybackState::Failed)
                }
                None => {
                    sending = false;
                    match conn.send_json(&CoreMessage::PlayEnd { play: id }).await {
                        Ok(()) => Step::Continue,
                        Err(_) => Step::End(PlaybackState::Failed),
                    }
                }
            },
        };
        if let Step::End(end) = step {
            return end;
        }
    }
}
