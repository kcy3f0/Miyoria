//! Speaking: `VoiceSink` → TTS → voice node playback.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use futures::StreamExt;
use miyoria_kernel::ModuleContext;
use miyoria_speech::{SpeechService, TtsRequest};
use miyoria_types::{ContextKey, Event, PlaybackState, SpeakOutcome, TurnId, VoiceSink};
use tracing::warn;

use crate::barge::BargeIn;
use crate::config::{VoiceConfig, VoiceProfile};
use crate::link::{Playback, VoiceLink};
use crate::listen::millis;
use crate::text::strip_tags;

/// The `dyn VoiceSink` provided by the `voice` module.
pub(crate) struct Speaker {
    pub ctx: ModuleContext,
    pub link: Arc<VoiceLink>,
    pub speech: Arc<SpeechService>,
    pub profile: Arc<VoiceProfile>,
    pub config: Arc<VoiceConfig>,
    pub barge: Arc<BargeIn>,
}

/// Unregisters from barge-in and stops the playback if `speak` is dropped
/// early (e.g. the scheduler timed it out).
struct Guard<'a> {
    barge: &'a BargeIn,
    guild: &'a str,
    token: u64,
    playback: Playback,
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.barge.unregister(self.guild, self.token);
        self.playback.stop(0);
    }
}

impl Speaker {
    fn publish(&self, event: Event, turn: Option<TurnId>) {
        match turn {
            Some(turn) => self.ctx.publish_in_turn(event, turn),
            None => self.ctx.publish(event),
        }
    }

    fn playback_event(
        &self,
        context: &ContextKey,
        turn: Option<TurnId>,
        state: PlaybackState,
        text: &str,
    ) {
        self.publish(
            Event::VoicePlayback {
                context: context.clone(),
                turn,
                state,
                text: text.to_owned(),
            },
            turn,
        );
    }

    async fn start(
        &self,
        context: &ContextKey,
        guild: &str,
        text: &str,
        emotion: Option<&str>,
        turn: Option<TurnId>,
    ) -> anyhow::Result<Playback> {
        let request = TtsRequest {
            text: text.to_owned(),
            language: Some(self.config.tts_language.clone()),
            emotion: emotion.map(str::to_owned),
            instruct: self.profile.instruct_for(emotion),
            voice: Some(self.profile.voice.clone()),
        };
        let t0 = Instant::now();
        let (provider, mut stream) = self.speech.synthesize(request).await?;
        let first = loop {
            match stream.next().await {
                Some(Ok(chunk)) if chunk.samples.is_empty() => {}
                Some(Ok(chunk)) => break chunk,
                Some(Err(e)) => return Err(e),
                None => anyhow::bail!("TTS returned no audio"),
            }
        };
        let first_audio_ms = millis(t0.elapsed());
        self.publish(
            Event::Custom {
                topic: crate::LATENCY_TOPIC.to_owned(),
                payload: serde_json::json!({
                    "stage": "tts",
                    "context": context,
                    "turn": turn,
                    "provider": provider,
                    "chars": text.chars().count(),
                    "first_audio_ms": first_audio_ms,
                }),
            },
            turn,
        );
        let rate = first.sample_rate;
        let audio = futures::stream::once(async move { Ok(first) })
            .chain(stream)
            .boxed();
        self.link.play(guild, rate, audio).await
    }
}

#[async_trait]
impl VoiceSink for Speaker {
    async fn speak(
        &self,
        context: &ContextKey,
        text: &str,
        emotion: Option<&str>,
        turn: Option<TurnId>,
    ) -> anyhow::Result<SpeakOutcome> {
        let guild = context
            .scope
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("voice context `{context}` has no guild"))?;
        let text = strip_tags(text);
        if text.is_empty() {
            return Ok(SpeakOutcome::Completed);
        }
        let playback = match self.start(context, guild, &text, emotion, turn).await {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, "cannot start speech");
                self.playback_event(context, turn, PlaybackState::Failed, &text);
                return Err(e);
            }
        };
        self.playback_event(context, turn, PlaybackState::Started, &text);
        let token = self.barge.register(guild, Arc::new(playback.clone()));
        let guard = Guard {
            barge: &self.barge,
            guild,
            token,
            playback: playback.clone(),
        };
        let state = playback.wait().await;
        drop(guard);
        self.playback_event(context, turn, state, &text);
        match state {
            PlaybackState::Finished => Ok(SpeakOutcome::Completed),
            PlaybackState::Interrupted => Ok(SpeakOutcome::Interrupted),
            PlaybackState::Started | PlaybackState::Failed => {
                anyhow::bail!("playback failed")
            }
        }
    }
}
