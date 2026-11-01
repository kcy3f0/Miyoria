//! One turn: attention decision, prompt assembly, generation and output.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{Local, Utc};
use futures::StreamExt;
use miyoria_llm::{ChatRequest, LlmRouter, StreamEvent};
use miyoria_types::{
    Action, ActionPayload, ActionSink, ContextKey, ContextKind, DecisionTrace, Event,
    IncomingMessage, LaneKey, OutgoingMessage, Priority, TurnId,
};
use parking_lot::Mutex;
use serde::Deserialize;
use tracing::{debug, warn};

use crate::attention::{self, AttentionInput, Gate};
use crate::config::ChannelMode;
use crate::expression::{Expression, ExpressionParser, Segment};
use crate::prompt::{self, Situation};
use crate::runtime::Agent;
use crate::session::Session;

const TYPING_TTL: Duration = Duration::from_secs(10);
/// History lines shown to the `fast` model.
const CHECK_HISTORY: usize = 12;

pub(crate) async fn run(
    agent: Arc<Agent>,
    key: ContextKey,
    session: Arc<Mutex<Session>>,
    turn: TurnId,
    inputs: Vec<IncomingMessage>,
    submitted: Arc<AtomicBool>,
) {
    let t = Turn {
        agent: &agent,
        key: &key,
        session: &session,
        turn,
        inputs: &inputs,
    };
    let text = match t.respond(&submitted).await {
        Ok(text) => text,
        Err(e) => {
            warn!(%turn, context = %key, error = %format!("{e:#}"), "turn failed");
            String::new()
        }
    };
    agent.ctx.publish_in_turn(
        Event::AgentTurnCompleted {
            turn,
            context: key.clone(),
            text,
        },
        turn,
    );
}

struct Turn<'a> {
    agent: &'a Agent,
    key: &'a ContextKey,
    session: &'a Arc<Mutex<Session>>,
    turn: TurnId,
    inputs: &'a [IncomingMessage],
}

#[derive(Deserialize)]
struct CheckReply {
    respond: bool,
    #[serde(default)]
    reason: String,
}

impl Turn<'_> {
    /// Returns the text she sent (empty if she stayed quiet).
    async fn respond(&self, submitted: &AtomicBool) -> anyhow::Result<String> {
        let names = self.agent.persona.names();
        let Some(direct) = self.decide(&names).await else {
            return Ok(String::new());
        };
        self.generate(direct, &names, submitted).await
    }

    /// Runs attention; `Some(direct)` if she should respond.
    async fn decide(&self, names: &[String]) -> Option<bool> {
        let cfg = &self.agent.config;
        let (profile_mode, profile_share) = self.agent.persona.read(|p| {
            let b = &p.manifest.behavior;
            (b.default_channel_mode.clone(), b.max_share_of_recent)
        });
        let profile_mode = profile_mode.parse().unwrap_or_else(|e| {
            warn!(error = %e, "invalid default_channel_mode in profile, using mention-only");
            ChannelMode::MentionOnly
        });
        let assessment = {
            let session = self.session.lock();
            attention::assess(&AttentionInput {
                config: &cfg.attention,
                mode: cfg.mode_for(self.key, profile_mode),
                names,
                max_share: cfg.attention.max_share_of_recent.unwrap_or(profile_share),
                session: &session,
                inputs: self.inputs,
                now: Utc::now(),
            })
        };
        let mut reasons = assessment.reasons;
        let probability = match assessment.gate {
            Gate::Ignore => 0.0,
            Gate::Sample(p) => p,
            Gate::AskLlm => match self.llm_check().await {
                Ok(reply) if reply.respond => {
                    reasons.push(format!("fast model: respond ({})", reply.reason));
                    cfg.attention.llm_yes_probability
                }
                Ok(reply) => {
                    reasons.push(format!("fast model: stay quiet ({})", reply.reason));
                    0.0
                }
                Err(e) => {
                    reasons.push(format!("fast model check failed: {e:#}"));
                    assessment.score
                }
            },
        };
        let (respond, roll) = attention::decide(probability, &*self.agent.random);
        match roll {
            Some(roll) => reasons.push(format!("p {probability:.2}, roll {roll:.2}")),
            None => reasons.push(format!("p {probability:.2}")),
        }
        self.agent.ctx.publish_in_turn(
            Event::AgentDecision(DecisionTrace {
                turn: self.turn,
                context: self.key.clone(),
                respond,
                score: assessment.score,
                reasons,
            }),
            self.turn,
        );
        respond.then_some(assessment.direct)
    }

    async fn llm_check(&self) -> anyhow::Result<CheckReply> {
        let router = self.agent.ctx.services().require::<LlmRouter>()?;
        let name = self.agent.persona.display_name();
        let messages = {
            let session = self.session.lock();
            prompt::check_messages(&name, session.recent(CHECK_HISTORY))
        };
        let request = ChatRequest {
            messages,
            temperature: Some(0.0),
            max_tokens: Some(120),
            json_mode: true,
            ..Default::default()
        };
        let timeout = Duration::from_millis(self.agent.config.attention.llm_check_timeout_ms);
        let response = tokio::time::timeout(timeout, router.complete("fast", request))
            .await
            .map_err(|_| anyhow::anyhow!("timed out"))??;
        parse_check(&response.text)
    }

    async fn generate(
        &self,
        direct: bool,
        names: &[String],
        submitted: &AtomicBool,
    ) -> anyhow::Result<String> {
        let cfg = &self.agent.config;
        let services = self.agent.ctx.services();
        let router = services.require::<LlmRouter>()?;
        let sink = services.require::<dyn ActionSink>()?;

        let persona = self.agent.persona.persona_prompt();
        let messages = {
            let session = self.session.lock();
            let present: Vec<String> = session
                .participants()
                .iter()
                .take(10)
                .map(|p| p.display_name.clone())
                .collect();
            let situation = prompt::situation_prompt(
                &Situation {
                    context: self.key,
                    present: &present,
                    direct,
                },
                Local::now(),
            );
            prompt::build_messages(&persona, &situation, session.recent(cfg.prompt_history))
        };

        let priority = if direct {
            Priority::Direct
        } else {
            Priority::Initiative
        };
        let lane = LaneKey::text(self.key);
        let typing = Action::new(
            lane.clone(),
            priority,
            ActionPayload::Typing {
                context: self.key.clone(),
            },
        )
        .with_ttl(TYPING_TTL)
        .with_turn(self.turn)
        .with_coalesce_key(format!("typing:{}", self.key));
        if let Err(e) = sink.submit(typing).await {
            warn!(error = %e, "could not submit typing action");
        }

        let request = ChatRequest {
            messages,
            temperature: cfg.temperature,
            max_tokens: cfg.max_tokens,
            ..Default::default()
        };
        let mut stream = router.stream("chat", request).await?;
        let mut parser = ExpressionParser::new();
        let mut expression = Expression::default();
        while let Some(event) = stream.next().await {
            match event? {
                StreamEvent::TextDelta(text) => {
                    for segment in parser.push(&text) {
                        self.apply(&mut expression, segment);
                    }
                    if expression.silence {
                        break;
                    }
                }
                StreamEvent::ReasoningDelta(text) => {
                    debug!(turn = %self.turn, reasoning = %text, "reasoning");
                }
                StreamEvent::ToolCallDelta { .. } => {}
                StreamEvent::Done { .. } => break,
            }
        }
        drop(stream);
        for segment in parser.finish() {
            self.apply(&mut expression, segment);
        }
        if expression.is_silent() {
            debug!(turn = %self.turn, "she chose silence");
            return Ok(String::new());
        }
        let text = prompt::clean_reply(&expression.text, names);
        if text.is_empty() {
            return Ok(String::new());
        }

        let reply_to = (cfg.reply_reference && direct && self.key.kind != ContextKind::Dm)
            .then(|| self.inputs.last().map(|m| m.id.clone()))
            .flatten();
        let display_name = self.agent.persona.display_name();
        let me = self.agent.self_account(&self.key.platform);
        submitted.store(true, Ordering::SeqCst);
        for (i, chunk) in prompt::split_message(&text, cfg.max_message_chars)
            .into_iter()
            .enumerate()
        {
            let action = Action::new(
                lane.clone(),
                priority,
                ActionPayload::SendMessage {
                    context: self.key.clone(),
                    message: OutgoingMessage {
                        text: chunk.clone(),
                        reply_to: if i == 0 { reply_to.clone() } else { None },
                    },
                },
            )
            .with_ttl(cfg.reply_ttl())
            .with_turn(self.turn);
            let id = action.id;
            self.session
                .lock()
                .record_own(&display_name, me.clone(), &chunk, id, Utc::now());
            self.agent.track_action(id, self.session.clone());
            if let Err(e) = sink.submit(action).await {
                self.agent.untrack_action(id);
                self.session.lock().forget_action(id);
                return Err(e.context("submitting reply"));
            }
        }
        Ok(text)
    }

    fn apply(&self, expression: &mut Expression, segment: Segment) {
        if let Segment::Emotion(emotion) = &segment {
            if !expression.silence {
                self.agent.ctx.publish_in_turn(
                    Event::Custom {
                        topic: "agent.emotion".into(),
                        payload: serde_json::json!({
                            "turn": self.turn,
                            "context": self.key,
                            "emotion": emotion,
                        }),
                    },
                    self.turn,
                );
            }
        }
        expression.apply(segment);
    }
}

fn parse_check(text: &str) -> anyhow::Result<CheckReply> {
    let start = text.find('{');
    let end = text.rfind('}');
    match (start, end) {
        (Some(s), Some(e)) if s < e => serde_json::from_str(&text[s..=e])
            .map_err(|err| anyhow::anyhow!("invalid JSON from fast model: {err}")),
        _ => anyhow::bail!("no JSON object in fast model reply"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_check_replies() {
        let r = parse_check("```json\n{\"respond\": true, \"reason\": \"被問問題\"}\n```").unwrap();
        assert!(r.respond);
        assert_eq!(r.reason, "被問問題");
        assert!(!parse_check("{\"respond\": false}").unwrap().respond);
        assert!(parse_check("yes").is_err());
        assert!(parse_check("{\"respond\": \"maybe\"}").is_err());
    }
}
