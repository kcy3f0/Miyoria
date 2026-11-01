//! Listening: audio streams → consent filter → segmentation → ASR →
//! `VoiceUtterance` events.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use miyoria_kernel::ModuleContext;
use miyoria_speech::{AsrHint, AudioBuf, SpeechService};
use miyoria_types::{Author, Event, VoiceUtterance};
use tokio::sync::{Semaphore, mpsc};
use tracing::{debug, info, warn};

use crate::barge::BargeIn;
use crate::config::VoiceConfig;
use crate::consent::Consent;
use crate::link::{AudioEvent, StreamInfo, VoiceLink};
use crate::segment::{Segmenter, SegmenterConfig, Utterance};
use crate::text::clean_transcript;
use crate::vad::{EnergyVad, EnergyVadConfig};

/// Streams without frames for this long are closed.
const STALE_STREAM: Duration = Duration::from_secs(30);

struct Stream {
    info: StreamInfo,
    /// `None` when the speaker is not listened to (no consent, self).
    segmenter: Option<Segmenter<EnergyVad>>,
    last_frame: Instant,
}

/// Everything the listening loop and its ASR tasks need.
#[derive(Clone)]
pub(crate) struct Listener {
    pub ctx: ModuleContext,
    pub link: Arc<VoiceLink>,
    pub speech: Arc<SpeechService>,
    pub consent: Arc<Consent>,
    pub config: Arc<VoiceConfig>,
    pub barge: Arc<BargeIn>,
    pub asr_slots: Arc<Semaphore>,
}

impl Listener {
    pub async fn run(self, mut audio: mpsc::Receiver<AudioEvent>) -> anyhow::Result<()> {
        let cancel = self.ctx.cancellation().clone();
        let mut streams: HashMap<u64, Stream> = HashMap::new();
        let mut sweep = tokio::time::interval(Duration::from_secs(5));
        loop {
            tokio::select! {
                () = cancel.cancelled() => return Ok(()),
                _ = sweep.tick() => {
                    let stale: Vec<u64> = streams
                        .iter()
                        .filter(|(_, s)| s.last_frame.elapsed() > STALE_STREAM)
                        .map(|(id, _)| *id)
                        .collect();
                    for id in stale {
                        debug!(stream = id, "closing stale audio stream");
                        if let Some(s) = streams.remove(&id) {
                            self.close(s);
                        }
                    }
                }
                event = audio.recv() => match event {
                    None => return Ok(()),
                    Some(AudioEvent::StreamOpen(info)) => {
                        let id = info.stream;
                        let stream = self.open(info).await;
                        if let Some(old) = streams.insert(id, stream) {
                            self.close(old);
                        }
                    }
                    Some(AudioEvent::Frame { stream, samples }) => {
                        if let Some(s) = streams.get_mut(&stream) {
                            self.frame(s, &samples);
                        }
                    }
                    Some(AudioEvent::StreamClose { stream }) => {
                        if let Some(s) = streams.remove(&stream) {
                            self.close(s);
                        }
                    }
                },
            }
        }
    }

    async fn open(&self, info: StreamInfo) -> Stream {
        let listen = if self.link.is_self(&info.speaker) {
            false
        } else if !self.consent.allowed(&info.speaker).await {
            debug!(speaker = %info.speaker.id, "no voice consent, dropping stream");
            false
        } else if info.sample_rate < 8_000 {
            warn!(
                sample_rate = info.sample_rate,
                "unsupported capture sample rate"
            );
            false
        } else {
            true
        };
        let segmenter = listen.then(|| {
            let vad = EnergyVad::new(EnergyVadConfig {
                sample_rate: info.sample_rate,
                ..EnergyVadConfig::default()
            });
            Segmenter::new(
                vad,
                SegmenterConfig {
                    sample_rate: info.sample_rate,
                    ..self.config.segmenter()
                },
            )
        });
        Stream {
            info,
            segmenter,
            last_frame: Instant::now(),
        }
    }

    fn frame(&self, stream: &mut Stream, samples: &[i16]) {
        stream.last_frame = Instant::now();
        let Some(seg) = stream.segmenter.as_mut() else {
            return; // Not listened to: the audio is discarded right here.
        };
        let utterances = seg.push(samples);
        if let Some(guild) = &stream.info.context.scope {
            self.barge.observe(guild, seg.speech_run_ms());
        }
        for u in utterances {
            self.transcribe(stream.info.clone(), u);
        }
    }

    fn close(&self, mut stream: Stream) {
        if let Some(u) = stream.segmenter.as_mut().and_then(Segmenter::finish) {
            self.transcribe(stream.info, u);
        }
    }

    /// Runs ASR in the background (bounded by `asr_concurrency`).
    fn transcribe(&self, info: StreamInfo, utterance: Utterance) {
        let detected = Utc::now();
        let ended_at =
            detected - chrono::Duration::milliseconds(i64::from(utterance.trailing_silence_ms));
        let started_at = ended_at - chrono::Duration::milliseconds(i64::from(utterance.speech_ms));
        let this = self.clone();
        let cancel = self.ctx.cancellation().clone();
        self.ctx.spawn("asr", async move {
            tokio::select! {
                () = cancel.cancelled() => {}
                () = this.asr(info, utterance, started_at, ended_at) => {}
            }
            Ok(())
        });
    }

    fn hint(&self, guild: &str) -> AsrHint {
        let mut prompt = self
            .config
            .asr_prompt
            .clone()
            .filter(|p| !p.trim().is_empty());
        if self.config.asr_prompt_participants {
            let names: Vec<String> = self
                .link
                .participants(guild)
                .into_iter()
                .map(|p| p.display_name)
                .filter(|n| !n.is_empty())
                .collect();
            if !names.is_empty() {
                let names = names.join("、");
                prompt = Some(match prompt {
                    Some(p) => format!("{p} {names}"),
                    None => names,
                });
            }
        }
        AsrHint {
            language: self.config.asr_language.clone(),
            prompt,
        }
    }

    async fn asr(
        &self,
        info: StreamInfo,
        utterance: Utterance,
        started_at: chrono::DateTime<Utc>,
        ended_at: chrono::DateTime<Utc>,
    ) {
        let Ok(_permit) = self.asr_slots.acquire().await else {
            return;
        };
        let guild = info.context.scope.clone().unwrap_or_default();
        let hint = self.hint(&guild);
        let audio = AudioBuf {
            sample_rate: info.sample_rate,
            samples: utterance.samples,
        };
        let audio_ms = audio.duration_ms();
        let t0 = Instant::now();
        let (provider, transcript) = match self.speech.transcribe(&audio, &hint).await {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, speaker = %info.speaker.id, "ASR failed");
                return;
            }
        };
        let transcribe_ms = millis(t0.elapsed());
        let asr_ms =
            u32::try_from((Utc::now() - ended_at).num_milliseconds().max(0)).unwrap_or(u32::MAX);
        let Some(text) = clean_transcript(
            &transcript.text,
            self.config.to_traditional,
            &self.config.hallucinations,
        ) else {
            debug!(raw = %transcript.text, "dropped empty or hallucinated transcript");
            return;
        };
        let display_name = self
            .link
            .participants(&guild)
            .into_iter()
            .find(|p| p.account == info.speaker)
            .map(|p| p.display_name)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| info.display_name.clone());
        info!(speaker = %display_name, %text, asr_ms, "voice utterance");
        self.ctx.publish(Event::VoiceUtterance(VoiceUtterance {
            id: ulid::Ulid::new().to_string(),
            context: info.context.clone(),
            speaker: Author {
                account: info.speaker.clone(),
                display_name,
                is_bot: false,
            },
            text,
            language: transcript.language,
            emotion: transcript.emotion,
            audio_events: transcript.audio_events,
            started_at,
            ended_at,
            asr_ms,
        }));
        self.ctx.publish(Event::Custom {
            topic: crate::LATENCY_TOPIC.to_owned(),
            payload: serde_json::json!({
                "stage": "asr",
                "context": info.context,
                "speaker": info.speaker,
                "provider": provider,
                "audio_ms": audio_ms,
                "transcribe_ms": transcribe_ms,
                "asr_ms": asr_ms,
            }),
        });
    }
}

pub(crate) fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}
