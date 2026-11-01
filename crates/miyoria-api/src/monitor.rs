//! Live state the API derives from the bus: the voice channels she is in
//! (participants, who is speaking, recent latency) and whether her own
//! speech is playing. Only events seen since the `api` module started count.

use std::collections::VecDeque;

use chrono::{DateTime, Duration, Utc};
use miyoria_kernel::{Subscription, TopicFilter};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, Envelope, Event, PlaybackState, TurnId, VoiceParticipant,
};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::types::{LatencyStats, VoiceLatency, VoiceSession, VoiceState};

/// Topics the monitor follows.
pub(crate) fn topics() -> TopicFilter {
    TopicFilter::new(["voice.*", "agent.turn.started"])
}

/// Latency samples older than this are dropped.
const WINDOW_MINUTES: i64 = 15;
const MAX_SAMPLES: usize = 512;

#[derive(Default)]
struct Samples(VecDeque<(DateTime<Utc>, u32)>);

impl Samples {
    fn push(&mut self, at: DateTime<Utc>, ms: u32) {
        self.0.push_back((at, ms));
        while self.0.len() > MAX_SAMPLES {
            self.0.pop_front();
        }
    }

    fn stats(&mut self, now: DateTime<Utc>) -> LatencyStats {
        let cutoff = now - Duration::minutes(WINDOW_MINUTES);
        while self.0.front().is_some_and(|(at, _)| *at < cutoff) {
            self.0.pop_front();
        }
        let mut values: Vec<u32> = self.0.iter().map(|(_, ms)| *ms).collect();
        values.sort_unstable();
        LatencyStats {
            p50_ms: percentile(&values, 0.50),
            p95_ms: percentile(&values, 0.95),
            samples: u32::try_from(values.len()).unwrap_or(u32::MAX),
        }
    }
}

/// Nearest-rank percentile of sorted values.
fn percentile(sorted: &[u32], p: f64) -> Option<u32> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (p * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

struct Session {
    context: ContextKey,
    participants: Vec<VoiceParticipant>,
    speaking: Vec<AccountRef>,
    joined_at: DateTime<Utc>,
    last_turn: Option<TurnId>,
    asr: Samples,
    llm: Samples,
    tts: Samples,
}

impl Session {
    fn new(context: ContextKey, joined_at: DateTime<Utc>) -> Self {
        Self {
            context,
            participants: Vec::new(),
            speaking: Vec::new(),
            joined_at,
            last_turn: None,
            asr: Samples::default(),
            llm: Samples::default(),
            tts: Samples::default(),
        }
    }
}

#[derive(Default)]
struct State {
    sessions: Vec<Session>,
    /// Contexts where her playback is running.
    playing: Vec<ContextKey>,
    /// Last expression triggered through the API.
    expression: Option<String>,
}

impl State {
    fn session(&mut self, context: &ContextKey) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|s| &s.context == context)
    }

    fn session_or_new(&mut self, context: &ContextKey, at: DateTime<Utc>) -> &mut Session {
        let index = match self.sessions.iter().position(|s| &s.context == context) {
            Some(i) => i,
            None => {
                self.sessions.push(Session::new(context.clone(), at));
                self.sessions.len() - 1
            }
        };
        &mut self.sessions[index]
    }
}

#[derive(Default)]
pub(crate) struct Monitor {
    state: Mutex<State>,
}

impl Monitor {
    /// Applies bus events until cancelled or the bus closes.
    pub(crate) async fn run(&self, mut sub: Subscription, cancel: CancellationToken) {
        loop {
            let env = tokio::select! {
                env = sub.recv() => env,
                () = cancel.cancelled() => return,
            };
            match env {
                Some(env) => self.handle(&env),
                None => return,
            }
        }
    }

    pub(crate) fn handle(&self, env: &Envelope) {
        let mut st = self.state.lock();
        let at = env.ts;
        match &env.event {
            Event::VoiceJoined {
                context,
                participants,
            } => {
                st.sessions.retain(|s| &s.context != context);
                let mut session = Session::new(context.clone(), at);
                session.participants.clone_from(participants);
                st.sessions.push(session);
            }
            Event::VoiceLeft { context, .. } => {
                st.sessions.retain(|s| &s.context != context);
                st.playing.retain(|c| c != context);
            }
            Event::VoiceParticipants {
                context,
                participants,
            } => {
                let session = st.session_or_new(context, at);
                session.participants.clone_from(participants);
                session
                    .speaking
                    .retain(|a| participants.iter().any(|p| &p.account == a));
            }
            Event::VoiceSpeaking {
                context,
                account,
                speaking,
            } => {
                if let Some(session) = st.session(context) {
                    session.speaking.retain(|a| a != account);
                    if *speaking {
                        session.speaking.push(account.clone());
                    }
                }
            }
            Event::VoicePlayback {
                context,
                turn,
                state,
                ..
            } => {
                st.playing.retain(|c| c != context);
                if *state == PlaybackState::Started {
                    st.playing.push(context.clone());
                }
                if let (Some(turn), Some(session)) = (turn, st.session(context)) {
                    session.last_turn = Some(*turn);
                }
            }
            Event::AgentTurnStarted { turn, context } if context.kind == ContextKind::Voice => {
                if let Some(session) = st.session(context) {
                    session.last_turn = Some(*turn);
                }
            }
            Event::Custom { topic, payload } if topic == "voice.latency" => {
                let Some(context) = payload
                    .get("context")
                    .and_then(|c| serde_json::from_value::<ContextKey>(c.clone()).ok())
                else {
                    return;
                };
                let ms = |key: &str| {
                    payload
                        .get(key)
                        .and_then(serde_json::Value::as_f64)
                        .filter(|v| v.is_finite() && *v >= 0.0)
                        .map(|v| v.min(f64::from(u32::MAX)) as u32)
                };
                let Some(session) = st.session(&context) else {
                    return;
                };
                match payload.get("stage").and_then(serde_json::Value::as_str) {
                    Some("asr") => {
                        if let Some(v) = ms("asr_ms") {
                            session.asr.push(at, v);
                        }
                    }
                    Some("tts") => {
                        if let Some(v) = ms("first_audio_ms") {
                            session.tts.push(at, v);
                        }
                    }
                    Some("llm") => {
                        if let Some(v) = ms("first_token_ms") {
                            session.llm.push(at, v);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// Voice channels she is in, oldest join first.
    pub(crate) fn voice(&self, now: DateTime<Utc>) -> VoiceState {
        let mut st = self.state.lock();
        VoiceState {
            sessions: st
                .sessions
                .iter_mut()
                .map(|s| VoiceSession {
                    context: s.context.clone(),
                    label: None,
                    participants: s.participants.clone(),
                    speaking: s.speaking.clone(),
                    joined_at: s.joined_at,
                    latency: VoiceLatency {
                        asr: s.asr.stats(now),
                        llm_first_token: s.llm.stats(now),
                        tts_first_audio: s.tts.stats(now),
                    },
                    last_turn: s.last_turn,
                })
                .collect(),
        }
    }

    /// The voice channel to speak in: the one joined first.
    pub(crate) fn voice_context(&self) -> Option<ContextKey> {
        self.state
            .lock()
            .sessions
            .first()
            .map(|s| s.context.clone())
    }

    /// Her speech is playing somewhere.
    pub(crate) fn speaking(&self) -> bool {
        !self.state.lock().playing.is_empty()
    }

    pub(crate) fn expression(&self) -> Option<String> {
        self.state.lock().expression.clone()
    }

    pub(crate) fn set_expression(&self, expression: &str) {
        self.state.lock().expression = Some(expression.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miyoria_types::{ModuleId, PlatformId};

    #[test]
    fn percentiles_use_nearest_rank() {
        assert_eq!(percentile(&[], 0.5), None);
        assert_eq!(percentile(&[7], 0.95), Some(7));
        let v: Vec<u32> = (1..=100).collect();
        assert_eq!(percentile(&v, 0.50), Some(50));
        assert_eq!(percentile(&v, 0.95), Some(95));
    }

    #[test]
    fn tracks_sessions_speaking_and_latency() {
        let m = Monitor::default();
        let context = ContextKey {
            platform: PlatformId::new("discord"),
            scope: Some("g".into()),
            channel: "vc".into(),
            kind: ContextKind::Voice,
        };
        let me = AccountRef {
            platform: PlatformId::new("discord"),
            id: "1".into(),
        };
        let send = |event| m.handle(&Envelope::new(ModuleId::from("voice"), event));
        send(Event::VoiceJoined {
            context: context.clone(),
            participants: vec![VoiceParticipant {
                account: me.clone(),
                display_name: "Mika".into(),
                is_self: false,
                muted: false,
                deafened: false,
            }],
        });
        send(Event::VoiceSpeaking {
            context: context.clone(),
            account: me.clone(),
            speaking: true,
        });
        for ms in [100, 300, 200] {
            send(Event::Custom {
                topic: "voice.latency".into(),
                payload: serde_json::json!({ "stage": "asr", "context": context, "asr_ms": ms }),
            });
        }
        send(Event::VoicePlayback {
            context: context.clone(),
            turn: None,
            state: PlaybackState::Started,
            text: "hi".into(),
        });
        assert!(m.speaking());
        let state = m.voice(Utc::now());
        assert_eq!(state.sessions.len(), 1);
        let s = &state.sessions[0];
        assert_eq!(s.speaking, [me]);
        assert_eq!(s.latency.asr.samples, 3);
        assert_eq!(s.latency.asr.p50_ms, Some(200));
        assert_eq!(s.latency.tts_first_audio.p50_ms, None);

        send(Event::VoiceLeft {
            context,
            reason: None,
        });
        assert!(!m.speaking());
        assert!(m.voice(Utc::now()).sessions.is_empty());
        assert_eq!(m.voice_context(), None);
    }
}
