//! One turn: attention decision, prompt assembly, generation (with the tool
//! loop) and output.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{Local, Utc};
use futures::StreamExt;
use miyoria_llm::{ChatMessage, ChatRequest, LlmRouter, StreamEvent, ToolCall};
use miyoria_types::{
    AccountRef, Action, ActionPayload, ActionSink, Authorizer, ContextKey, ContextKind,
    DecisionTrace, Event, IncomingMessage, LaneKey, OutgoingMessage, Priority, TurnId,
};
use parking_lot::Mutex;
use serde::Deserialize;
use tracing::{debug, warn};

use crate::attention::{self, AttentionInput, Gate};
use crate::expression::{Expression, ExpressionParser, Segment};
use crate::prompt::{self, Situation};
use crate::runtime::Agent;
use crate::session::Session;
use crate::tools::ToolContext;

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

/// One model response of the generation loop.
struct Step {
    expression: Expression,
    /// Raw text as the model wrote it (tags included).
    raw: String,
    calls: Vec<ToolCall>,
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
        let (interests, profile_share) = self.agent.persona.read(|p| {
            (
                p.manifest.interests.clone(),
                p.manifest.behavior.max_share_of_recent,
            )
        });
        let mode = self.agent.handle.channel_mode(self.key);
        let activeness = self.agent.handle.activeness(self.key);
        let assessment = {
            let session = self.session.lock();
            attention::assess(&AttentionInput {
                config: &cfg.attention,
                mode,
                activeness,
                names,
                interests: &interests,
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
                    activeness.scale(cfg.attention.llm_yes_probability)
                }
                Ok(reply) => {
                    reasons.push(format!("fast model: stay quiet ({})", reply.reason));
                    0.0
                }
                Err(e) => {
                    reasons.push(format!("fast model check failed: {e:#}"));
                    activeness.scale(assessment.score)
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
        // Typing is refreshed until the reply is ready; dropping the turn
        // (cancellation) stops it too.
        let expression = tokio::select! {
            biased;
            () = self.keep_typing(&*sink, &lane, priority) => unreachable!("typing never ends"),
            expression = self.produce(&router, messages, priority) => expression?,
        };
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

    /// Submits a typing indicator every `typing_refresh_ms`. Never returns.
    async fn keep_typing(&self, sink: &dyn ActionSink, lane: &LaneKey, priority: Priority) {
        let refresh = self.agent.config.typing_refresh();
        loop {
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
            tokio::time::sleep(refresh).await;
        }
    }

    /// Runs the model, executing tool calls for up to `max_tool_steps`
    /// rounds, and returns the reply to send.
    ///
    /// Text written alongside tool calls is kept in the conversation sent back
    /// to the model but only used as the reply if the final response has none,
    /// so it is never sent twice.
    async fn produce(
        &self,
        router: &LlmRouter,
        mut messages: Vec<ChatMessage>,
        priority: Priority,
    ) -> anyhow::Result<Expression> {
        let cfg = &self.agent.config;
        let tools_enabled = cfg.tools_enabled && !self.inputs.is_empty();
        let mut earlier: Option<Expression> = None;
        for step in 0..=cfg.max_tool_steps {
            let tools = if tools_enabled {
                self.agent.tools.specs()
            } else {
                Vec::new()
            };
            let offered = !tools.is_empty();
            let request = ChatRequest {
                messages: messages.clone(),
                tools,
                temperature: cfg.temperature,
                max_tokens: cfg.max_tokens,
                ..Default::default()
            };
            let Step {
                expression,
                raw,
                calls,
            } = self.stream_step(router, request).await?;
            if calls.is_empty() || !offered || step == cfg.max_tool_steps {
                if !calls.is_empty() {
                    warn!(turn = %self.turn, offered, "ignoring tool calls (disabled or step limit reached)");
                }
                return Ok(match earlier {
                    Some(earlier) if expression.is_silent() => earlier,
                    _ => expression,
                });
            }
            if !expression.is_silent() {
                earlier = Some(expression);
            }
            messages.push(ChatMessage {
                tool_calls: calls.clone(),
                ..ChatMessage::assistant(raw)
            });
            for call in &calls {
                let result = self.run_tool(call, priority).await;
                messages.push(ChatMessage::tool_result(call.id.clone(), result));
            }
        }
        Ok(earlier.unwrap_or_default())
    }

    /// Streams one model response, publishing emotions as they arrive.
    async fn stream_step(&self, router: &LlmRouter, request: ChatRequest) -> anyhow::Result<Step> {
        let offered_tools = !request.tools.is_empty();
        let mut stream = router.stream("chat", request).await?;
        let mut parser = ExpressionParser::new();
        let mut expression = Expression::default();
        let mut raw = String::new();
        let mut calls: Vec<ToolCall> = Vec::new();
        while let Some(event) = stream.next().await {
            match event? {
                StreamEvent::TextDelta(text) => {
                    raw.push_str(&text);
                    for segment in parser.push(&text) {
                        self.apply(&mut expression, segment);
                    }
                    // With tools on offer, calls may still follow the silence.
                    if expression.silence && !offered_tools {
                        break;
                    }
                }
                StreamEvent::ReasoningDelta(text) => {
                    debug!(turn = %self.turn, reasoning = %text, "reasoning");
                }
                StreamEvent::ToolCallDelta {
                    index,
                    id,
                    name,
                    arguments,
                } => {
                    let index = index as usize;
                    while calls.len() <= index {
                        calls.push(ToolCall {
                            id: String::new(),
                            name: String::new(),
                            arguments: String::new(),
                        });
                    }
                    let call = &mut calls[index];
                    if let Some(id) = id {
                        call.id = id;
                    }
                    if let Some(name) = name {
                        call.name.push_str(&name);
                    }
                    call.arguments.push_str(&arguments);
                }
                StreamEvent::Done { .. } => break,
            }
        }
        drop(stream);
        for segment in parser.finish() {
            self.apply(&mut expression, segment);
        }
        calls.retain(|c| !c.name.is_empty());
        for (i, call) in calls.iter_mut().enumerate() {
            if call.id.is_empty() {
                call.id = format!("call_{i}");
            }
        }
        Ok(Step {
            expression,
            raw,
            calls,
        })
    }

    /// Distinct authors of the turn's messages; a tool permission must be
    /// granted to all of them.
    fn authors(&self) -> Vec<&AccountRef> {
        let mut out: Vec<&AccountRef> = Vec::new();
        for m in self.inputs {
            if !out.contains(&&m.author.account) {
                out.push(&m.author.account);
            }
        }
        out
    }

    /// Runs one tool call; the result (or error) is a short text for the model.
    async fn run_tool(&self, call: &ToolCall, priority: Priority) -> String {
        let (ok, result) = self.try_tool(call, priority).await;
        let result = truncate(&result, self.agent.config.max_tool_result_chars);
        debug!(turn = %self.turn, tool = %call.name, ok, %result, "tool call");
        self.agent.ctx.publish_in_turn(
            Event::Custom {
                topic: "agent.tool".into(),
                payload: serde_json::json!({
                    "turn": self.turn,
                    "context": self.key,
                    "tool": call.name,
                    "ok": ok,
                    "result": result,
                }),
            },
            self.turn,
        );
        result
    }

    async fn try_tool(&self, call: &ToolCall, priority: Priority) -> (bool, String) {
        let Some(tool) = self.agent.tools.get(&call.name) else {
            return (false, format!("error: unknown tool `{}`", call.name));
        };
        if let Some(node) = tool.permission() {
            let authorizer = self.agent.ctx.services().get::<dyn Authorizer>();
            let allowed = authorizer
                .is_some_and(|a| self.authors().iter().all(|account| a.allows(account, node)));
            if !allowed {
                return (
                    false,
                    "error: permission denied (the user who asked may not use this tool)".into(),
                );
            }
        }
        let args = if call.arguments.trim().is_empty() {
            serde_json::json!({})
        } else {
            match serde_json::from_str(&call.arguments) {
                Ok(v) => v,
                Err(e) => return (false, format!("error: arguments are not valid JSON: {e}")),
            }
        };
        let Some(last) = self.inputs.last() else {
            return (false, "error: no triggering message".into());
        };
        let ctx = ToolContext {
            turn: self.turn,
            context: self.key.clone(),
            account: last.author.account.clone(),
            message: last.id.clone(),
            priority,
        };
        match tokio::time::timeout(self.agent.config.tool_timeout(), tool.call(&ctx, args)).await {
            Ok(Ok(out)) => (true, out),
            Ok(Err(e)) => (false, format!("error: {e:#}")),
            Err(_) => (false, "error: timed out".into()),
        }
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

fn truncate(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_owned(),
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

    #[test]
    fn truncates_tool_results() {
        assert_eq!(truncate("短", 5), "短");
        assert_eq!(truncate("一二三四五六", 3), "一二三…");
    }
}
