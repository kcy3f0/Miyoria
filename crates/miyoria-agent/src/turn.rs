//! One turn: attention decision, prompt assembly (including the sections of
//! prompt contributors), generation (with the tool loop) and output. Text
//! replies are sent once complete; voice replies are spoken sentence by
//! sentence while the model is still generating.
//!
//! An initiative turn has no input and skips attention (the coordinator
//! already checked the context is quiet). While the LLM budget is exhausted
//! nothing is generated: a turn she would have answered gets a canned line at
//! most once per context per `budget_notice_interval_ms`.

use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

use chrono::{Local, Utc};
use futures::StreamExt;
use miyoria_llm::{ChatMessage, ChatRequest, LlmRouter, StreamEvent, ToolCall, ToolSpec};
use miyoria_types::{
    AccountRef, Action, ActionPayload, ActionSink, Authorizer, ContextKey, ContextKind,
    DecisionTrace, Event, IncomingMessage, LaneKey, OutgoingMessage, Participant, Priority,
    PromptContributors, PromptRequest, SocialSignals, TurnId,
};
use parking_lot::Mutex;
use serde::Deserialize;
use tracing::{debug, warn};

use crate::attention::{self, AttentionInput, Gate, VoiceAttention};
use crate::config::{AttentionConfig, ChannelMode};
use crate::contributors;
use crate::coordinator::TurnFlags;
use crate::expression::{Expression, ExpressionParser, Segment};
use crate::handle::voice_scope;
use crate::prompt::{self, Situation};
use crate::runtime::{Agent, Initiative};
use crate::session::{HistoryEntry, Session};
use crate::signals::{self, BudgetState, EXHAUSTED_LINE};
use crate::speech::{self, SentenceSplitter};
use crate::tools::{ReactTool, Tool, ToolContext};

const TYPING_TTL: Duration = Duration::from_secs(10);
/// History lines shown to the `fast` model.
const CHECK_HISTORY: usize = 12;
/// History lines before the input sent to prompt contributors.
const CONTRIBUTOR_HISTORY: usize = 6;
/// People in the prompt request (text contexts) and with attitude hints.
const MAX_PEOPLE: usize = 10;
const MAX_ATTITUDE_HINTS: usize = 5;

pub(crate) async fn run(
    agent: Arc<Agent>,
    key: ContextKey,
    session: Arc<Mutex<Session>>,
    turn: TurnId,
    inputs: Vec<IncomingMessage>,
    initiative: Option<Initiative>,
    flags: Arc<TurnFlags>,
) {
    let t = Turn {
        agent: &agent,
        key: &key,
        session: &session,
        turn,
        inputs: &inputs,
        initiative: initiative.as_ref(),
        voice: key.kind == ContextKind::Voice,
        social: agent.social(),
    };
    let text = match t.respond(&flags).await {
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
    /// She starts the conversation on her own (`inputs` is empty).
    initiative: Option<&'a Initiative>,
    /// A voice channel: the reply is spoken.
    voice: bool,
    social: Option<Arc<dyn SocialSignals>>,
}

/// What attention concluded (not yet published).
struct Decision {
    respond: bool,
    direct: bool,
    score: f32,
    reasons: Vec<String>,
}

/// Per-turn additions to the situation message.
#[derive(Default)]
struct Extras {
    /// Mood and attitude lines.
    notes: Vec<String>,
    /// Rendered contributor sections.
    sections: Option<String>,
    /// For the decision trace.
    reasons: Vec<String>,
}

/// One model response of the generation loop.
struct Step {
    expression: Expression,
    /// Raw text as the model wrote it (tags included).
    raw: String,
    calls: Vec<ToolCall>,
}

/// Streams a voice reply: every completed sentence is submitted as a `Speak`
/// action right away, so the first one plays while the rest is generated.
struct Speech<'a> {
    sink: &'a dyn ActionSink,
    flags: &'a TurnFlags,
    names: &'a [String],
    context: &'a ContextKey,
    turn: TurnId,
    lane: LaneKey,
    priority: Priority,
    ttl: Duration,
    splitter: SentenceSplitter,
    /// Latest `<emo:...>`; sent with each sentence.
    emotion: Option<String>,
    /// Everything submitted so far.
    spoken: String,
}

impl Speech<'_> {
    /// Her speech was interrupted: nothing more is said.
    fn stopped(&self) -> bool {
        TurnFlags::get(&self.flags.interrupted)
    }

    async fn text(&mut self, text: &str) -> anyhow::Result<()> {
        for sentence in self.splitter.push(text) {
            self.say(&sentence).await?;
        }
        Ok(())
    }

    /// A new emotion applies from the next sentence on: a finished sentence
    /// that was still held is said with the previous one first.
    async fn emotion(&mut self, emotion: &str) -> anyhow::Result<()> {
        if let Some(done) = self.splitter.flush_complete() {
            self.say(&done).await?;
        }
        self.emotion = Some(emotion.to_owned());
        Ok(())
    }

    /// Says the unfinished rest (end of a response, or a pause).
    async fn flush(&mut self) -> anyhow::Result<()> {
        match self.splitter.flush() {
            Some(rest) => self.say(&rest).await,
            None => Ok(()),
        }
    }

    async fn say(&mut self, sentence: &str) -> anyhow::Result<()> {
        if self.stopped() {
            return Ok(());
        }
        let text = prompt::clean_reply(sentence, self.names);
        if !speech::is_speakable(&text) {
            return Ok(());
        }
        let action = Action::new(
            self.lane.clone(),
            self.priority,
            ActionPayload::Speak {
                context: self.context.clone(),
                text: text.clone(),
                emotion: self.emotion.clone(),
            },
        )
        .with_ttl(self.ttl)
        .with_turn(self.turn);
        self.sink
            .submit(action)
            .await
            .map_err(|e| e.context("submitting speech"))?;
        TurnFlags::set(&self.flags.queued);
        self.spoken.push_str(&text);
        Ok(())
    }
}

#[derive(Deserialize)]
struct CheckReply {
    respond: bool,
    #[serde(default)]
    reason: String,
}

impl Turn<'_> {
    /// Returns the text she sent or said (empty if she stayed quiet).
    async fn respond(&self, flags: &TurnFlags) -> anyhow::Result<String> {
        let names = self.agent.persona.names();
        let budget = self.agent.handle.llm_budget();
        let Decision {
            respond,
            direct,
            score,
            mut reasons,
        } = match self.initiative {
            Some(initiative) => {
                let mut reasons = vec![format!("initiative:{}", initiative.reason)];
                let respond = budget == BudgetState::Ok;
                if !respond {
                    reasons.push(format!("skipped: llm budget {budget}"));
                }
                Decision {
                    respond,
                    direct: false,
                    score: 0.0,
                    reasons,
                }
            }
            None => self.decide(&names, budget).await,
        };
        if !respond {
            self.publish_decision(false, score, reasons);
            return Ok(String::new());
        }
        if budget == BudgetState::Exhausted {
            let notice = self.agent.take_budget_notice(self.key);
            reasons.push(if notice {
                "llm budget exhausted: out-of-energy line".into()
            } else {
                "llm budget exhausted: already told them, staying quiet".into()
            });
            self.publish_decision(notice, score, reasons);
            return if notice {
                self.say_exhausted(direct, flags).await
            } else {
                Ok(String::new())
            };
        }
        let extras = self.extras().await;
        reasons.extend(extras.reasons.iter().cloned());
        self.publish_decision(true, score, reasons);
        self.generate(direct, &names, flags, &extras).await
    }

    fn publish_decision(&self, respond: bool, score: f32, reasons: Vec<String>) {
        self.agent.ctx.publish_in_turn(
            Event::AgentDecision(DecisionTrace {
                turn: self.turn,
                context: self.key.clone(),
                respond,
                score,
                reasons,
            }),
            self.turn,
        );
    }

    /// Someone she ignores entirely (only their old lines can still be in
    /// history: new ones are not recorded).
    fn hidden(&self, entry: &HistoryEntry) -> bool {
        !entry.is_self
            && self
                .social
                .as_ref()
                .and_then(|s| s.attitude(&entry.account))
                .is_some_and(|a| a.blocked)
    }

    /// Mean affinity of the turn's speakers (unknown people count as 0), if
    /// social signals are available.
    fn speaker_affinity(&self) -> Option<f32> {
        let social = self.social.as_ref()?;
        let authors = self.authors();
        if authors.is_empty() {
            return None;
        }
        let sum: f32 = authors
            .iter()
            .map(|a| social.attitude(a).map_or(0.0, |t| t.affinity))
            .sum();
        Some(sum / authors.len() as f32)
    }

    /// Runs attention.
    async fn decide(&self, names: &[String], budget: BudgetState) -> Decision {
        let cfg = &self.agent.config;
        let (interests, profile_share) = self.agent.persona.read(|p| {
            (
                p.manifest.interests.clone(),
                p.manifest.behavior.max_share_of_recent,
            )
        });
        let configured = self.agent.handle.channel_mode(self.key);
        // Short on budget: no joining in, no fast-model checks.
        let mode = if budget != BudgetState::Ok && configured == ChannelMode::Ambient {
            ChannelMode::MentionOnly
        } else {
            configured
        };
        let activeness = self.agent.handle.activeness(self.key);
        let affinity = self.speaker_affinity();
        let mood = self.agent.mood();
        let voice = &cfg.voice;
        let (attention_cfg, max_share) = if self.voice {
            let cfg = AttentionConfig {
                cooldown_ms: voice.cooldown_ms,
                llm_check: voice.llm_check,
                ..cfg.attention.clone()
            };
            (Cow::Owned(cfg), voice.max_share_of_recent)
        } else {
            (
                Cow::Borrowed(&cfg.attention),
                cfg.attention.max_share_of_recent.unwrap_or(profile_share),
            )
        };
        let assessment = {
            let session = self.session.lock();
            attention::assess(&AttentionInput {
                config: &attention_cfg,
                mode,
                activeness,
                names,
                interests: &interests,
                max_share,
                session: &session,
                inputs: self.inputs,
                now: Utc::now(),
                voice: self.voice.then(|| VoiceAttention {
                    someone_speaking: session.someone_speaking(),
                    ambient_factor: voice.ambient_factor,
                    question_window_ms: i64::try_from(voice.question_window_ms).unwrap_or(i64::MAX),
                }),
                affinity,
                mood,
            })
        };
        let mut reasons = assessment.reasons;
        if mode != configured {
            reasons.push(format!("llm budget {budget}: as mention-only"));
        }
        let scale = assessment.ambient_scale;
        let ambient = |p: f32| (p * scale).clamp(0.0, 1.0);
        let probability = match assessment.gate {
            Gate::Ignore => 0.0,
            Gate::Sample(p) => p,
            Gate::AskLlm => match self.llm_check().await {
                Ok(reply) if reply.respond => {
                    reasons.push(format!("fast model: respond ({})", reply.reason));
                    ambient(cfg.attention.llm_yes_probability)
                }
                Ok(reply) => {
                    reasons.push(format!("fast model: stay quiet ({})", reply.reason));
                    0.0
                }
                Err(e) => {
                    reasons.push(format!("fast model check failed: {e:#}"));
                    ambient(assessment.score)
                }
            },
        };
        let (respond, roll) = attention::decide(probability, &*self.agent.random);
        match roll {
            Some(roll) => reasons.push(format!("p {probability:.2}, roll {roll:.2}")),
            None => reasons.push(format!("p {probability:.2}")),
        }
        Decision {
            respond,
            direct: assessment.direct,
            score: assessment.score,
            reasons,
        }
    }

    async fn llm_check(&self) -> anyhow::Result<CheckReply> {
        let router = self.agent.ctx.services().require::<LlmRouter>()?;
        let name = self.agent.persona.display_name();
        let messages = {
            let session = self.session.lock();
            prompt::check_messages(
                &name,
                session.recent(CHECK_HISTORY).filter(|e| !self.hidden(e)),
            )
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

    /// The name she knows `account` by in this turn.
    fn name_of(&self, session: &Session, account: &AccountRef) -> Option<String> {
        self.inputs
            .iter()
            .find(|m| &m.author.account == account)
            .map(|m| m.author.display_name.clone())
            .or_else(|| {
                session
                    .voice_members()
                    .iter()
                    .find(|m| &m.account == account)
                    .map(|m| m.display_name.clone())
            })
            .or_else(|| {
                session
                    .participants()
                    .into_iter()
                    .find(|p| &p.account == account)
                    .map(|p| p.display_name.clone())
            })
    }

    /// The people this turn is about: its speakers, or for an initiative the
    /// accounts its hint is about.
    fn focus(&self) -> Vec<AccountRef> {
        let mut out: Vec<AccountRef> = self.authors().into_iter().cloned().collect();
        for account in self.initiative.iter().flat_map(|i| &i.about) {
            if !out.contains(account) {
                out.push(account.clone());
            }
        }
        out
    }

    /// Mood and attitude lines, plus the sections of prompt contributors.
    async fn extras(&self) -> Extras {
        let mut extras = Extras::default();
        if let Some(mood) = self.agent.mood() {
            extras.notes.push(signals::mood_hint(&mood));
        }
        let focus = self.focus();
        if let Some(social) = &self.social {
            let session = self.session.lock();
            let hints: Vec<String> = focus
                .iter()
                .filter_map(|account| {
                    let attitude = social.attitude(account)?;
                    let name = self.name_of(&session, account)?;
                    Some(signals::attitude_hint(&name, &attitude))
                })
                .take(MAX_ATTITUDE_HINTS)
                .collect();
            extras.notes.extend(hints);
        }
        let Some(registry) = self.agent.ctx.services().get::<PromptContributors>() else {
            return extras;
        };
        if registry.all().is_empty() {
            return extras;
        }
        let request = self.prompt_request(focus);
        let cfg = &self.agent.config;
        let gathered = contributors::gather(&registry, &request, cfg.contributor_timeout()).await;
        extras.reasons = gathered.reasons();
        extras.sections = prompt::render_sections(gathered.sections, cfg.max_context_chars);
        extras
    }

    /// What prompt contributors get to see of this turn.
    fn prompt_request(&self, speakers: Vec<AccountRef>) -> PromptRequest {
        let her = self.agent.persona.display_name();
        let profile = self.agent.persona.read(|p| p.id.clone());
        let person = |account: &AccountRef| {
            self.social
                .as_ref()
                .and_then(|s| s.attitude(account))
                .map(|a| a.person)
        };
        let session = self.session.lock();
        let members = session.voice_members();
        let mut participants: Vec<Participant> = if self.voice && !members.is_empty() {
            members
                .iter()
                .map(|m| Participant {
                    account: m.account.clone(),
                    display_name: m.display_name.clone(),
                    person: person(&m.account),
                })
                .collect()
        } else {
            session
                .participants()
                .into_iter()
                .take(MAX_PEOPLE)
                .map(|p| Participant {
                    account: p.account.clone(),
                    display_name: p.display_name.clone(),
                    person: person(&p.account),
                })
                .collect()
        };
        // Speakers are always among the participants.
        for account in &speakers {
            if participants.iter().any(|p| &p.account == account) {
                continue;
            }
            if let Some(name) = self.name_of(&session, account) {
                participants.push(Participant {
                    account: account.clone(),
                    display_name: name,
                    person: person(account),
                });
            }
        }
        let speakers: Vec<AccountRef> = speakers
            .into_iter()
            .filter(|a| participants.iter().any(|p| &p.account == a))
            .collect();
        let query = match self.initiative {
            Some(initiative) => initiative.hint.trim().to_owned(),
            None => self
                .inputs
                .iter()
                .map(|m| {
                    format!(
                        "{}: {}",
                        m.author.display_name,
                        crate::session::message_text(m)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
        };
        let first_input = self.inputs.iter().map(|m| m.ts).min();
        let before: Vec<&HistoryEntry> = session
            .history()
            .iter()
            .filter(|e| first_input.is_none_or(|t| e.ts < t) && !self.hidden(e))
            .collect();
        let recent = before[before.len().saturating_sub(CONTRIBUTOR_HISTORY)..]
            .iter()
            .map(|e| prompt::transcript_line(e, &her))
            .collect();
        PromptRequest {
            profile,
            turn: self.turn,
            context: self.key.clone(),
            participants,
            speakers,
            query,
            recent,
            voice: self.voice,
            now: Utc::now(),
        }
    }

    async fn generate(
        &self,
        direct: bool,
        names: &[String],
        flags: &TurnFlags,
        extras: &Extras,
    ) -> anyhow::Result<String> {
        let cfg = &self.agent.config;
        let services = self.agent.ctx.services();
        let router = services.require::<LlmRouter>()?;
        let sink = services.require::<dyn ActionSink>()?;

        let persona = self.agent.persona.persona_prompt();
        let messages = {
            let session = self.session.lock();
            let members = session.voice_members();
            let present: Vec<String> = if self.voice && !members.is_empty() {
                members.iter().map(|m| m.display_name.clone()).collect()
            } else {
                session
                    .participants()
                    .iter()
                    .take(MAX_PEOPLE)
                    .map(|p| p.display_name.clone())
                    .collect()
            };
            let mut situation = prompt::situation_prompt(
                &Situation {
                    context: self.key,
                    present: &present,
                    direct,
                    initiative: self.initiative.map(|i| i.hint.as_str()),
                    notes: &extras.notes,
                },
                Local::now(),
            );
            if let Some(sections) = &extras.sections {
                situation.push_str("\n\n");
                situation.push_str(sections);
            }
            prompt::build_messages(
                &persona,
                &situation,
                session
                    .recent(cfg.prompt_history)
                    .filter(|e| !self.hidden(e)),
            )
        };

        let priority = if direct {
            Priority::Direct
        } else {
            Priority::Initiative
        };
        if self.voice {
            let (platform, scope) = voice_scope(self.key);
            let mut speech = Some(Speech {
                sink: &*sink,
                flags,
                names,
                context: self.key,
                turn: self.turn,
                lane: LaneKey::voice(platform.as_str(), &scope),
                priority,
                ttl: cfg.voice.speak_ttl(),
                splitter: SentenceSplitter::new(),
                emotion: None,
                spoken: String::new(),
            });
            self.produce(&router, messages, priority, &mut speech)
                .await?;
            let spoken = speech.map(|s| s.spoken).unwrap_or_default();
            if spoken.is_empty() {
                debug!(turn = %self.turn, "she stayed quiet");
            }
            return Ok(spoken);
        }

        let lane = LaneKey::text(self.key);
        let mut no_speech = None;
        // Typing is refreshed until the reply is ready; dropping the turn
        // (cancellation) stops it too.
        let expression = tokio::select! {
            biased;
            () = self.keep_typing(&*sink, &lane, priority) => unreachable!("typing never ends"),
            expression = self.produce(&router, messages, priority, &mut no_speech) => expression?,
        };
        if expression.is_silent() {
            debug!(turn = %self.turn, "she chose silence");
            return Ok(String::new());
        }
        let text = prompt::clean_reply(&expression.text, names);
        if text.is_empty() {
            return Ok(String::new());
        }
        self.send_text(&*sink, text, direct, priority, flags).await
    }

    /// Sends `text` (split into several messages if long) as her reply.
    async fn send_text(
        &self,
        sink: &dyn ActionSink,
        text: String,
        direct: bool,
        priority: Priority,
        flags: &TurnFlags,
    ) -> anyhow::Result<String> {
        let cfg = &self.agent.config;
        let lane = LaneKey::text(self.key);
        let reply_to = (cfg.reply_reference && direct && self.key.kind != ContextKind::Dm)
            .then(|| self.inputs.last().map(|m| m.id.clone()))
            .flatten();
        let display_name = self.agent.persona.display_name();
        let me = self.agent.self_account(&self.key.platform);
        TurnFlags::set(&flags.committed);
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

    /// Budget exhausted: says (or writes) the constant out-of-energy line.
    async fn say_exhausted(&self, direct: bool, flags: &TurnFlags) -> anyhow::Result<String> {
        let sink = self.agent.ctx.services().require::<dyn ActionSink>()?;
        let priority = if direct {
            Priority::Direct
        } else {
            Priority::Initiative
        };
        if !self.voice {
            return self
                .send_text(&*sink, EXHAUSTED_LINE.to_owned(), direct, priority, flags)
                .await;
        }
        let (platform, scope) = voice_scope(self.key);
        let action = Action::new(
            LaneKey::voice(platform.as_str(), &scope),
            priority,
            ActionPayload::Speak {
                context: self.key.clone(),
                text: EXHAUSTED_LINE.to_owned(),
                emotion: Some("tired".into()),
            },
        )
        .with_ttl(self.agent.config.voice.speak_ttl())
        .with_turn(self.turn);
        sink.submit(action)
            .await
            .map_err(|e| e.context("submitting speech"))?;
        Ok(EXHAUSTED_LINE.to_owned())
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
    /// so it is never sent twice. With `speech` (voice), all text is spoken as
    /// it streams in, including text written alongside tool calls.
    async fn produce(
        &self,
        router: &LlmRouter,
        mut messages: Vec<ChatMessage>,
        priority: Priority,
        speech: &mut Option<Speech<'_>>,
    ) -> anyhow::Result<Expression> {
        let cfg = &self.agent.config;
        let tools_enabled = cfg.tools_enabled && !self.inputs.is_empty();
        let mut earlier: Option<Expression> = None;
        for step in 0..=cfg.max_tool_steps {
            let tools = if tools_enabled {
                self.tool_specs()
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
            } = self.stream_step(router, request, speech).await?;
            if speech.as_ref().is_some_and(Speech::stopped) {
                debug!(turn = %self.turn, "speech interrupted, generation stopped");
                return Ok(expression);
            }
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

    /// Streams one model response, publishing emotions as they arrive (and
    /// speaking its sentences, with `speech`).
    async fn stream_step(
        &self,
        router: &LlmRouter,
        request: ChatRequest,
        speech: &mut Option<Speech<'_>>,
    ) -> anyhow::Result<Step> {
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
                        self.take(&mut expression, segment, speech).await?;
                    }
                    // With tools on offer, calls may still follow the silence.
                    if expression.silence && !offered_tools {
                        break;
                    }
                    if speech.as_ref().is_some_and(Speech::stopped) {
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
            self.take(&mut expression, segment, speech).await?;
        }
        if let Some(speech) = speech {
            speech.flush().await?;
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

    /// The tools offered in this context (`react` makes no sense in voice).
    fn offers(&self, name: &str) -> bool {
        !(self.voice && name == ReactTool::NAME)
    }

    fn tool_specs(&self) -> Vec<ToolSpec> {
        let mut specs = self.agent.tools.specs();
        specs.retain(|t| self.offers(&t.name));
        specs
    }

    fn tool(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.offers(name)
            .then(|| self.agent.tools.get(name))
            .flatten()
    }

    async fn try_tool(&self, call: &ToolCall, priority: Priority) -> (bool, String) {
        let Some(tool) = self.tool(&call.name) else {
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

    /// Folds a segment into `expression`; with `speech`, also speaks text and
    /// tracks the emotion for the next sentence (nothing after a silence).
    async fn take(
        &self,
        expression: &mut Expression,
        segment: Segment,
        speech: &mut Option<Speech<'_>>,
    ) -> anyhow::Result<()> {
        let silent = expression.silence;
        let out = speech.as_mut().filter(|_| !silent);
        let Some(out) = out else {
            self.apply(expression, segment);
            return Ok(());
        };
        match &segment {
            Segment::Text(text) => {
                let text = text.clone();
                self.apply(expression, segment);
                return out.text(&text).await;
            }
            Segment::Emotion(emotion) => out.emotion(emotion).await?,
            Segment::Pause(_) => out.flush().await?,
            Segment::Silence => {}
        }
        self.apply(expression, segment);
        Ok(())
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
