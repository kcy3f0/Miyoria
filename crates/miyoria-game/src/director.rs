//! The director task: one game session at a time, a decision every
//! `decide_secs` (sooner on important events), goal tracking, queue goals,
//! commentary and mood nudges.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use miyoria_kernel::ModuleContext;
use miyoria_llm::{ChatMessage, ChatRequest, LlmRouter};
use miyoria_queue::RequestQueue;
use miyoria_tools::{ToolContext, ToolRegistry};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, Envelope, Event, MessageRef, Priority, TurnId,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tracing::{debug, info, warn};

use crate::config::GameConfig;
use crate::decision::{
    ActionCall, Decision, GoalFacts, GoalSource, MoodNudge, PromptParts, ReportedStatus, Verdict,
    judge, prompts, split_observation,
};

/// Topic of the director's decision traces (for the panel / overlay).
pub const DECISION_TOPIC: &str = "game.director.decision";
/// Initiative reason of commentary requests.
pub const INITIATIVE_REASON: &str = "game";

/// Persona bits used in the decision prompt.
#[derive(Clone, Debug, Default)]
pub struct Persona {
    pub name: String,
    pub text: String,
}

/// Where `game start` sends commentary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    /// Her voice channel, else the stream context, else where the command ran.
    Auto,
    Voice,
    Here,
    Stream,
}

/// Requests from the commands to the director task.
pub enum Control {
    Start {
        game: String,
        placement: Placement,
        here: ContextKey,
        invoker: AccountRef,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Stop {
        reply: oneshot::Sender<Result<String, String>>,
    },
    Goal {
        text: String,
        by: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
}

/// Current goal as shown by `game status` and the prompt section.
#[derive(Clone, Debug, Serialize)]
pub struct GoalView {
    pub text: String,
    /// `(觀眾 Owen 的請求)`, empty for her own goals.
    pub note: String,
    pub age_secs: u64,
    pub action: Option<String>,
    /// Request queue item id for viewer goals.
    pub queue_item: Option<u64>,
}

/// Snapshot of the running session.
#[derive(Clone, Debug, Serialize)]
pub struct GameStatus {
    pub game: String,
    pub game_name: String,
    pub context: ContextKey,
    pub started_at: DateTime<Utc>,
    pub goal: Option<GoalView>,
    pub backlog: Vec<String>,
    pub summary: String,
    pub busy: Option<bool>,
    pub last_action: Option<String>,
    pub recent: Vec<String>,
}

pub(crate) type View = Arc<Mutex<Option<GameStatus>>>;

struct Goal {
    text: String,
    source: GoalSource,
    set_at: Instant,
    action: Option<ActionCall>,
    issued_at: Option<Instant>,
    attempts: u32,
}

impl Goal {
    fn new(text: impl Into<String>, source: GoalSource) -> Self {
        Self {
            text: text.into(),
            source,
            set_at: Instant::now(),
            action: None,
            issued_at: None,
            attempts: 0,
        }
    }

    fn label(&self) -> String {
        format!("{}{}", self.text, self.source.note())
    }
}

struct QueuedGoal {
    item: u64,
    text: String,
    requester: String,
}

#[derive(Clone, Debug, Default)]
struct Trigger {
    text: Vec<String>,
    important: bool,
}

enum Outcome {
    Reached,
    Failed(String),
}

struct Session {
    generation: u64,
    game: String,
    game_name: String,
    context: ContextKey,
    starter: AccountRef,
    started_at: DateTime<Utc>,
    goal: Option<Goal>,
    backlog: VecDeque<QueuedGoal>,
    recent: VecDeque<String>,
    summary: String,
    busy: Option<bool>,
    last_action: Option<String>,
    next_decide: Instant,
    decide_started: Option<Instant>,
    trigger: Option<Trigger>,
    last_comment: Option<Instant>,
}

impl Session {
    fn observe_tool(&self) -> String {
        format!("game_{}_observe", self.game)
    }

    fn act_tool(&self) -> String {
        format!("game_{}_act", self.game)
    }

    fn tool_ctx(&self) -> ToolContext {
        ToolContext {
            turn: TurnId::new(),
            context: self.context.clone(),
            account: self.starter.clone(),
            message: MessageRef {
                context: self.context.clone(),
                id: "game".to_owned(),
            },
            priority: Priority::Initiative,
        }
    }
}

type Work = Pin<Box<dyn Future<Output = Done> + Send>>;

/// Result of a background step.
enum Done {
    Decided {
        generation: u64,
        trigger: Trigger,
        observation: anyhow::Result<String>,
        decision: Option<anyhow::Result<Decision>>,
    },
    Acted {
        generation: u64,
        action: ActionCall,
        verdict: Verdict,
        goal: Option<String>,
        result: anyhow::Result<String>,
    },
}

pub(crate) struct Director {
    cfg: Arc<GameConfig>,
    ctx: ModuleContext,
    persona: Persona,
    view: View,
    voices: Vec<ContextKey>,
    session: Option<Session>,
    generation: u64,
}

fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or_default();
    let mut out: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        out.push('…');
    }
    out
}

/// `"在 Minecraft 裡做一個高階動作"` → `Minecraft`; else the capitalized id.
fn game_name(act_description: Option<&str>, id: &str) -> String {
    act_description
        .and_then(|d| d.strip_prefix("在 "))
        .and_then(|d| d.split_once(" 裡"))
        .map(|(name, _)| name.trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| {
            let mut c = id.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect())
                .unwrap_or_default()
        })
}

async fn call_tool(
    tools: &ToolRegistry,
    name: &str,
    ctx: &ToolContext,
    args: Value,
    timeout: Duration,
) -> anyhow::Result<String> {
    let tool = tools
        .get(name)
        .ok_or_else(|| anyhow::anyhow!("tool `{name}` is not registered"))?;
    tokio::time::timeout(timeout, tool.call(ctx, args))
        .await
        .map_err(|_| anyhow::anyhow!("tool `{name}` timed out"))?
}

/// Everything a decision needs, owned so it can run in the background.
struct DecideInput {
    generation: u64,
    trigger: Trigger,
    cfg: Arc<GameConfig>,
    tools: Arc<ToolRegistry>,
    router: Option<Arc<LlmRouter>>,
    tool_ctx: ToolContext,
    observe_tool: String,
    act_tool: String,
    persona: Persona,
    game_name: String,
    goal: Option<String>,
    last_action: Option<String>,
    backlog: Vec<String>,
    recent: Vec<String>,
}

async fn decide(input: DecideInput) -> Done {
    let cfg = &input.cfg;
    let observation = call_tool(
        &input.tools,
        &input.observe_tool,
        &input.tool_ctx,
        json!({}),
        secs(cfg.tool_timeout_secs),
    )
    .await;
    let decision = match &observation {
        Ok(text) => decide_from(&input, text).await,
        Err(_) => None,
    };
    Done::Decided {
        generation: input.generation,
        trigger: input.trigger,
        observation,
        decision,
    }
}

/// Asks the model, unless the game is not playable right now.
async fn decide_from(input: &DecideInput, observation: &str) -> Option<anyhow::Result<Decision>> {
    let (_, state) = split_observation(observation);
    let unplayable = state.as_ref().is_some_and(|s| {
        s.get("connected") == Some(&Value::Bool(false))
            || s.get("in_game") == Some(&Value::Bool(false))
    });
    if unplayable {
        return None;
    }
    Some(ask(input, observation).await)
}

async fn ask(input: &DecideInput, observation: &str) -> anyhow::Result<Decision> {
    let cfg = &input.cfg;
    let act = input
        .tools
        .get(&input.act_tool)
        .ok_or_else(|| anyhow::anyhow!("tool `{}` is not registered", input.act_tool))?
        .spec();
    let router = input
        .router
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("no LLM router"))?;
    let trigger = if input.trigger.text.is_empty() {
        "定時檢查".to_owned()
    } else {
        input.trigger.text.join(";")
    };
    let (system, user) = prompts(&PromptParts {
        name: &input.persona.name,
        persona: &input.persona.text,
        game: &input.game_name,
        act_description: &act.description,
        act_parameters: &act.parameters,
        trigger: &trigger,
        goal: input.goal.clone(),
        last_action: input.last_action.clone(),
        backlog: input.backlog.clone(),
        recent: input.recent.clone(),
        observation,
    });
    let request = ChatRequest {
        messages: vec![ChatMessage::system(system), ChatMessage::user(user)],
        temperature: Some(cfg.temperature),
        max_tokens: Some(cfg.max_tokens),
        json_mode: true,
        ..ChatRequest::default()
    };
    let response = tokio::time::timeout(
        secs(cfg.llm_timeout_secs),
        router.complete(&cfg.purpose, request),
    )
    .await
    .map_err(|_| anyhow::anyhow!("the decision timed out"))??;
    Decision::parse(&response.text)
}

impl Director {
    pub(crate) fn new(
        cfg: Arc<GameConfig>,
        ctx: ModuleContext,
        persona: Persona,
        view: View,
    ) -> Self {
        Self {
            cfg,
            ctx,
            persona,
            view,
            voices: Vec::new(),
            session: None,
            generation: 0,
        }
    }

    pub(crate) async fn run(
        mut self,
        mut events: miyoria_kernel::Subscription,
        mut control: mpsc::UnboundedReceiver<Control>,
    ) -> anyhow::Result<()> {
        let cancel = self.ctx.cancellation().clone();
        let mut work: Option<Work> = None;
        loop {
            let wake = self
                .session
                .as_ref()
                .filter(|_| work.is_none())
                .map(|s| s.next_decide);
            tokio::select! {
                () = cancel.cancelled() => break,
                c = control.recv() => match c {
                    Some(c) => self.on_control(c, &mut work),
                    None => break,
                },
                env = events.recv() => match env {
                    Some(env) => self.on_event(&env),
                    None => break,
                },
                done = async { work.as_mut().expect("guarded").await }, if work.is_some() => {
                    work = self.on_done(done);
                }
                () = async { tokio::time::sleep_until(wake.expect("guarded")).await }, if wake.is_some() => {
                    work = self.start_decide();
                }
            }
        }
        Ok(())
    }

    fn refresh_view(&self) {
        let status = self.session.as_ref().map(|s| GameStatus {
            game: s.game.clone(),
            game_name: s.game_name.clone(),
            context: s.context.clone(),
            started_at: s.started_at,
            goal: s.goal.as_ref().map(|g| GoalView {
                text: g.text.clone(),
                note: g.source.note(),
                age_secs: g.set_at.elapsed().as_secs(),
                action: g.action.as_ref().map(ActionCall::display),
                queue_item: match g.source {
                    GoalSource::Queue { item, .. } => Some(item),
                    _ => None,
                },
            }),
            backlog: s
                .backlog
                .iter()
                .map(|q| format!("#{} {}({})", q.item, q.text, q.requester))
                .collect(),
            summary: s.summary.clone(),
            busy: s.busy,
            last_action: s.last_action.clone(),
            recent: s.recent.iter().cloned().collect(),
        });
        *self.view.lock() = status;
    }

    // ----- commands -----

    fn on_control(&mut self, control: Control, work: &mut Option<Work>) {
        match control {
            Control::Start {
                game,
                placement,
                here,
                invoker,
                reply,
            } => {
                let result = self.start(game, placement, here, invoker);
                if result.is_ok() {
                    *work = None;
                }
                let _ = reply.send(result);
            }
            Control::Stop { reply } => {
                let result = self.stop();
                if result.is_ok() {
                    *work = None;
                }
                let _ = reply.send(result);
            }
            Control::Goal { text, by, reply } => {
                let _ = reply.send(self.command_goal(text, by));
            }
        }
        self.refresh_view();
    }

    fn resolve_context(
        &self,
        placement: Placement,
        here: &ContextKey,
    ) -> Result<ContextKey, String> {
        let voice = || {
            self.voices
                .iter()
                .find(|v| v.platform == here.platform && v.scope == here.scope)
                .or_else(|| self.voices.first())
                .cloned()
        };
        let stream = || self.cfg.stream_context.clone();
        match placement {
            Placement::Auto => Ok(voice().or_else(stream).unwrap_or_else(|| here.clone())),
            Placement::Voice => {
                voice().ok_or_else(|| "我又不在語音頻道裡,要講給誰聽啦。".to_owned())
            }
            Placement::Here => Ok(here.clone()),
            Placement::Stream => stream()
                .ok_or_else(|| "沒有設定直播頻道([modules.game] stream_context)。".to_owned()),
        }
    }

    fn start(
        &mut self,
        game: String,
        placement: Placement,
        here: ContextKey,
        invoker: AccountRef,
    ) -> Result<String, String> {
        if let Some(s) = &self.session {
            return Err(format!(
                "已經在玩 {} 了啦,要換先 `game stop`。",
                s.game_name
            ));
        }
        let tools = self
            .ctx
            .services()
            .get::<ToolRegistry>()
            .ok_or_else(|| "工具系統沒開,沒辦法玩。".to_owned())?;
        let observe = format!("game_{game}_observe");
        let act = tools.get(&format!("game_{game}_act"));
        if tools.get(&observe).is_none() || act.is_none() {
            return Err(format!(
                "找不到 {game} 的遊戲 adapter(工具 `{observe}`),擴充有開嗎?"
            ));
        }
        let context = self.resolve_context(placement, &here)?;
        let game_name = game_name(act.map(|t| t.spec().description).as_deref(), &game);
        self.generation += 1;
        info!(%game, %context, "game session started");
        let where_ = if context.kind == ContextKind::Voice {
            "語音頻道"
        } else {
            "這邊"
        };
        self.session = Some(Session {
            generation: self.generation,
            game,
            game_name: game_name.clone(),
            context,
            starter: invoker,
            started_at: Utc::now(),
            goal: None,
            backlog: VecDeque::new(),
            recent: VecDeque::new(),
            summary: String::new(),
            busy: None,
            last_action: None,
            next_decide: Instant::now(),
            decide_started: None,
            trigger: Some(Trigger {
                text: vec!["剛開始玩".to_owned()],
                important: true,
            }),
            last_comment: None,
        });
        Ok(format!(
            "好啦,開始玩 {game_name}……才不是因為想玩才玩的喔。實況會在{where_}講。"
        ))
    }

    fn stop(&mut self) -> Result<String, String> {
        let Some(s) = self.session.take() else {
            return Err("本來就沒在玩啊。".to_owned());
        };
        self.generation += 1;
        info!(game = %s.game, "game session stopped");
        if let Some(tools) = self.ctx.services().get::<ToolRegistry>() {
            let act = s.act_tool();
            let ctx = s.tool_ctx();
            let timeout = secs(self.cfg.tool_timeout_secs);
            self.ctx.spawn("game-stop", async move {
                let args = ActionCall::new("stop", json!({})).tool_args();
                if let Err(e) = call_tool(&tools, &act, &ctx, args, timeout).await {
                    debug!(error = %e, "stopping the game bot failed");
                }
                Ok(())
            });
        }
        let mut open: Vec<u64> = s.backlog.iter().map(|q| q.item).collect();
        if let Some(GoalSource::Queue { item, .. }) = s.goal.as_ref().map(|g| &g.source) {
            open.insert(0, *item);
        }
        let mut text = format!("收工!{} 今天就玩到這裡。", s.game_name);
        if !open.is_empty() {
            let ids: Vec<String> = open.iter().map(|i| format!("#{i}")).collect();
            text.push_str(&format!("觀眾的請求 {} 還沒做完,先放著。", ids.join("、")));
        }
        Ok(text)
    }

    fn command_goal(&mut self, text: String, by: String) -> Result<String, String> {
        let Some(s) = &mut self.session else {
            return Err("又沒在玩,要我做什麼啦。".to_owned());
        };
        let text = text.trim().to_owned();
        if text.is_empty() {
            return Err("目標是什麼?講清楚啦。".to_owned());
        }
        if let Some(old) = s.goal.take()
            && let GoalSource::Queue { item, requester } = old.source
        {
            // The viewer's goal waits for its turn again.
            s.backlog.push_front(QueuedGoal {
                item,
                text: old.text,
                requester,
            });
        }
        s.goal = Some(Goal::new(text.clone(), GoalSource::Command { by }));
        self.trigger(format!("新目標:{text}"), true);
        Ok(format!("知道了啦,{text}。"))
    }

    // ----- events -----

    fn on_event(&mut self, env: &Envelope) {
        if env.source == *self.ctx.id() {
            return;
        }
        match &env.event {
            Event::VoiceJoined { context, .. } | Event::VoiceParticipants { context, .. } => {
                if !self.voices.contains(context) {
                    self.voices.push(context.clone());
                }
            }
            Event::VoiceLeft { context, .. } => self.voices.retain(|v| v != context),
            Event::Custom { topic, payload } if topic == "queue.item_activated" => {
                self.on_queue_item(payload);
            }
            Event::Custom { topic, payload } => {
                let Some(s) = &self.session else { return };
                let Some(kind) = topic
                    .strip_prefix("game.")
                    .and_then(|t| t.strip_prefix(s.game.as_str()))
                    .and_then(|t| t.strip_prefix('.'))
                else {
                    return;
                };
                let kind = payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or(kind)
                    .to_owned();
                self.on_game_event(&kind, payload);
            }
            _ => return,
        }
        self.refresh_view();
    }

    fn remember(&mut self, line: String) {
        let max = self.cfg.recent_events.max(1);
        if let Some(s) = &mut self.session {
            s.recent.push_back(line);
            while s.recent.len() > max {
                s.recent.pop_front();
            }
        }
    }

    fn on_game_event(&mut self, kind: &str, payload: &Value) {
        let data = payload.get("data").cloned().unwrap_or(Value::Null);
        let text = data
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| kind.to_owned());
        let important = payload.get("important").and_then(Value::as_bool) == Some(true);
        debug!(kind, %text, important, "game event");
        self.remember(text.clone());

        let settled = self.session.as_ref().is_some_and(|s| {
            s.goal
                .as_ref()
                .and_then(|g| g.issued_at)
                .is_some_and(|at| at.elapsed() >= secs(self.cfg.settle_secs))
        });
        let cancelled = data.get("cancelled") == Some(&Value::Bool(true));
        if settled && self.cfg.failed_events.iter().any(|e| e == kind) {
            self.finish_goal(Outcome::Failed(text.clone()));
        } else if settled && !cancelled && self.cfg.reached_events.iter().any(|e| e == kind) {
            self.finish_goal(Outcome::Reached);
        }

        match kind {
            "death" => {
                self.nudge(MoodNudge {
                    valence: -0.15,
                    arousal: 0.1,
                    energy: 0.0,
                    reason: "game: death".to_owned(),
                });
                if let Some(s) = &mut self.session {
                    match &mut s.goal {
                        // A requested goal survives the death; it is retried.
                        Some(g) if g.source.locked() => {
                            g.action = None;
                            g.issued_at = None;
                        }
                        _ => s.goal = None,
                    }
                }
                self.comment_event(&text, true);
            }
            "advancement" => {
                self.nudge(MoodNudge {
                    valence: 0.15,
                    arousal: 0.1,
                    energy: 0.0,
                    reason: "game: advancement".to_owned(),
                });
                self.comment_event(&text, true);
            }
            _ if important => self.comment_event(&text, true),
            _ => {}
        }
        if self.cfg.trigger_events.iter().any(|e| e == kind) {
            self.trigger(text, important);
        }
    }

    fn on_queue_item(&mut self, payload: &Value) {
        let kind = payload
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind != self.cfg.queue_kind {
            return;
        }
        let (Some(item), Some(text)) = (
            payload.get("id").and_then(Value::as_u64),
            payload.get("text").and_then(Value::as_str),
        ) else {
            warn!(%payload, "queue item without id or text");
            return;
        };
        let requester = payload
            .get("requester_name")
            .and_then(Value::as_str)
            .unwrap_or("觀眾")
            .to_owned();
        let Some(s) = &mut self.session else {
            debug!(item, "game goal activated while not playing; ignored");
            return;
        };
        let queued = QueuedGoal {
            item,
            text: text.to_owned(),
            requester,
        };
        if s.goal.as_ref().is_some_and(|g| g.source.locked()) {
            s.backlog.push_back(queued);
            return;
        }
        self.begin_queued(queued);
    }

    /// Makes a viewer goal current and announces it.
    fn begin_queued(&mut self, q: QueuedGoal) {
        let Some(s) = &mut self.session else { return };
        let line = format!("觀眾 {} 想要你:{}", q.requester, q.text);
        s.goal = Some(Goal::new(
            q.text,
            GoalSource::Queue {
                item: q.item,
                requester: q.requester,
            },
        ));
        self.remember(line.clone());
        self.comment(format!("{line}。回應一下,然後開始做。"), true);
        self.trigger(line, true);
    }

    fn finish_goal(&mut self, outcome: Outcome) {
        let Some(s) = &mut self.session else { return };
        let Some(goal) = s.goal.take() else { return };
        let (line, hint) = match (&outcome, &goal.source) {
            (Outcome::Reached, GoalSource::Queue { requester, .. }) => (
                format!("完成目標:{}", goal.label()),
                Some((
                    format!(
                        "完成了觀眾 {requester} 的請求「{}」,跟大家說一聲",
                        goal.text
                    ),
                    true,
                )),
            ),
            (Outcome::Failed(why), GoalSource::Queue { requester, .. }) => (
                format!("目標失敗:{}({why})", goal.label()),
                Some((
                    format!(
                        "觀眾 {requester} 的請求「{}」沒做成({why}),找個藉口",
                        goal.text
                    ),
                    true,
                )),
            ),
            (Outcome::Reached, _) => (
                format!("完成目標:{}", goal.label()),
                Some((format!("剛完成「{}」", goal.text), false)),
            ),
            (Outcome::Failed(why), _) => (format!("目標失敗:{}({why})", goal.label()), None),
        };
        info!(goal = %goal.text, reached = matches!(outcome, Outcome::Reached), "game goal finished");
        if let GoalSource::Queue { item, .. } = goal.source
            && let Some(queue) = self.ctx.services().get::<RequestQueue>()
        {
            let result = match outcome {
                Outcome::Reached => queue.complete(item),
                Outcome::Failed(_) => queue.skip(item),
            };
            if let Err(e) = result {
                warn!(item, error = %e, "could not finish the queue item");
            }
        }
        self.remember(line.clone());
        if let Some((hint, urgent)) = hint {
            self.comment(hint, urgent);
        }
        let next = self.session.as_mut().and_then(|s| s.backlog.pop_front());
        match next {
            Some(q) => self.begin_queued(q),
            None => self.trigger(line, false),
        }
    }

    /// Asks for an early decision (at most every `min_decide_secs`).
    fn trigger(&mut self, text: String, important: bool) {
        let min = secs(self.cfg.min_decide_secs);
        let Some(s) = &mut self.session else { return };
        let t = s.trigger.get_or_insert_with(Trigger::default);
        t.text.push(text);
        t.important |= important;
        let earliest = s
            .decide_started
            .map_or_else(Instant::now, |at| (at + min).max(Instant::now()));
        if earliest < s.next_decide {
            s.next_decide = earliest;
        }
    }

    // ----- commentary and mood -----

    /// Requests a commentary line; rate-limited unless urgent (urgent ones
    /// have their own, shorter limit). Returns whether it was sent.
    fn comment(&mut self, hint: String, urgent: bool) -> bool {
        let cfg = &self.cfg;
        let Some(s) = &mut self.session else {
            return false;
        };
        let gap = secs(if urgent {
            cfg.urgent_commentary_min_secs
        } else {
            cfg.commentary_min_secs
        });
        if s.last_comment.is_some_and(|at| at.elapsed() < gap) {
            debug!(%hint, urgent, "commentary rate-limited");
            return false;
        }
        s.last_comment = Some(Instant::now());
        let hint = if urgent {
            format!("(你正在直播玩 {}){hint}", s.game_name)
        } else {
            format!("(你正在直播玩 {})實況:{hint}", s.game_name)
        };
        self.ctx.publish(Event::AgentInitiative {
            context: s.context.clone(),
            reason: INITIATIVE_REASON.to_owned(),
            hint,
            about: Vec::new(),
        });
        true
    }

    fn comment_event(&mut self, text: &str, urgent: bool) {
        self.comment(format!("剛剛{text}!馬上用一兩句話反應。"), urgent);
    }

    fn nudge(&self, m: MoodNudge) {
        self.ctx.publish(Event::Custom {
            topic: "mood.nudge".to_owned(),
            payload: json!({
                "valence": m.valence,
                "arousal": m.arousal,
                "energy": m.energy,
                "reason": m.reason,
            }),
        });
    }

    // ----- decisions -----

    fn start_decide(&mut self) -> Option<Work> {
        let cfg = self.cfg.clone();
        let s = self.session.as_mut()?;
        // Hold the next tick far away until the result arrives.
        s.next_decide = Instant::now() + secs(cfg.decide_secs);
        s.decide_started = Some(Instant::now());
        let Some(tools) = self.ctx.services().get::<ToolRegistry>() else {
            warn!("no tool registry; cannot observe the game");
            return None;
        };
        let max_age = secs(cfg.max_goal_secs);
        if s.goal
            .as_ref()
            .is_some_and(|g| g.set_at.elapsed() >= max_age)
        {
            self.finish_goal(Outcome::Failed("太久了,放棄".to_owned()));
        }
        let s = self.session.as_mut()?;
        let input = DecideInput {
            generation: s.generation,
            trigger: s.trigger.take().unwrap_or_default(),
            cfg: cfg.clone(),
            tools,
            router: self.ctx.services().get::<LlmRouter>(),
            tool_ctx: s.tool_ctx(),
            observe_tool: s.observe_tool(),
            act_tool: s.act_tool(),
            persona: self.persona.clone(),
            game_name: s.game_name.clone(),
            goal: s.goal.as_ref().map(|g| {
                let status = if g.action.is_none() {
                    "還沒開始".to_owned()
                } else {
                    format!("已進行 {} 秒", g.set_at.elapsed().as_secs())
                };
                format!("{}({status})", g.label())
            }),
            last_action: s.last_action.clone(),
            backlog: s
                .backlog
                .iter()
                .map(|q| format!("{}({})", q.text, q.requester))
                .collect(),
            recent: s.recent.iter().cloned().collect(),
        };
        Some(Box::pin(decide(input)))
    }

    fn on_done(&mut self, done: Done) -> Option<Work> {
        let generation = match &done {
            Done::Decided { generation, .. } | Done::Acted { generation, .. } => *generation,
        };
        if self.session.as_ref().map(|s| s.generation) != Some(generation) {
            return None;
        }
        let next = match done {
            Done::Decided {
                trigger,
                observation,
                decision,
                ..
            } => self.on_decided(trigger, observation, decision),
            Done::Acted {
                action,
                verdict,
                goal,
                result,
                ..
            } => {
                self.on_acted(action, verdict, goal, result);
                None
            }
        };
        if next.is_none() {
            self.schedule_after_work();
        }
        self.refresh_view();
        next
    }

    fn schedule_after_work(&mut self) {
        let cfg = &self.cfg;
        let Some(s) = &mut self.session else { return };
        let now = Instant::now();
        s.next_decide = if s.trigger.is_some() {
            s.decide_started
                .map_or(now, |at| (at + secs(cfg.min_decide_secs)).max(now))
        } else {
            s.decide_started.unwrap_or(now) + secs(cfg.decide_secs)
        }
        .max(now);
    }

    fn on_decided(
        &mut self,
        trigger: Trigger,
        observation: anyhow::Result<String>,
        decision: Option<anyhow::Result<Decision>>,
    ) -> Option<Work> {
        let cfg = self.cfg.clone();
        let s = self.session.as_mut()?;
        match observation {
            Ok(text) => {
                let (summary, state) = split_observation(&text);
                s.busy = state
                    .as_ref()
                    .and_then(|st| st.get("busy"))
                    .and_then(Value::as_bool);
                s.summary = summary;
            }
            Err(e) => {
                warn!(error = %format!("{e:#}"), "observing the game failed");
                s.summary = format!("看不到遊戲畫面({e})");
                s.busy = None;
                return None;
            }
        }
        let decision = match decision? {
            Ok(d) => d,
            Err(e) => {
                warn!(error = %format!("{e:#}"), "game decision failed");
                return None;
            }
        };
        match decision.status {
            Some(ReportedStatus::Done) => self.finish_goal(Outcome::Reached),
            Some(ReportedStatus::Failed) => self.finish_goal(Outcome::Failed("做不到".to_owned())),
            _ => {}
        }
        if let Some(mut m) = decision.mood.clone() {
            let max = cfg.max_llm_nudge.abs();
            m.valence = m.valence.clamp(-max, max);
            m.arousal = m.arousal.clamp(-max, max);
            m.energy = m.energy.clamp(-max, max);
            if m.valence != 0.0 || m.arousal != 0.0 || m.energy != 0.0 {
                m.reason = format!("game: {}", m.reason);
                self.nudge(m);
            }
        }
        if let Some(c) = &decision.commentary {
            self.comment(c.clone(), false);
        }
        let s = self.session.as_mut()?;
        let verdict = decision.action.as_ref().map(|a| {
            let facts = s.goal.as_ref().map(|g| GoalFacts {
                text: &g.text,
                locked: g.source.locked(),
                pending: g.action.is_none(),
                action: g.action.as_ref(),
                age: g.set_at.elapsed(),
                since_issued: g.issued_at.map_or(Duration::ZERO, |at| at.elapsed()),
            });
            judge(
                &cfg,
                facts.as_ref(),
                a,
                decision.goal.as_deref(),
                s.busy,
                trigger.important,
            )
        });
        self.ctx.publish(Event::Custom {
            topic: DECISION_TOPIC.to_owned(),
            payload: json!({
                "game": s.game,
                "trigger": trigger.text,
                "goal": decision.goal,
                "action": decision.action.as_ref().map(ActionCall::display),
                "verdict": verdict.map(|v| format!("{v:?}")),
                "commentary": decision.commentary,
                "busy": s.busy,
            }),
        });
        let (action, verdict) = match (decision.action, verdict) {
            (Some(a), Some(v @ (Verdict::Step | Verdict::Replace))) => (a, v),
            (Some(a), Some(Verdict::Keep(why))) => {
                debug!(action = %a.display(), why, "kept the current goal");
                return None;
            }
            _ => return None,
        };
        let tools = self.ctx.services().get::<ToolRegistry>()?;
        let generation = s.generation;
        let act = s.act_tool();
        let ctx = s.tool_ctx();
        let timeout = secs(cfg.tool_timeout_secs);
        let goal = decision.goal;
        Some(Box::pin(async move {
            let result = call_tool(&tools, &act, &ctx, action.tool_args(), timeout).await;
            Done::Acted {
                generation,
                action,
                verdict,
                goal,
                result,
            }
        }))
    }

    fn on_acted(
        &mut self,
        action: ActionCall,
        verdict: Verdict,
        goal_text: Option<String>,
        result: anyhow::Result<String>,
    ) {
        let max_attempts = self.cfg.max_attempts.max(1);
        let instant = self.cfg.instant_actions.contains(&action.name);
        let Some(s) = &mut self.session else { return };
        let (ok, text) = match result {
            // The SDK formats results as `成功…` / `失敗…`.
            Ok(text) => (!text.starts_with("失敗"), text),
            Err(e) => (false, format!("失敗:{e}")),
        };
        s.last_action = Some(format!("{} → {}", action.display(), first_line(&text, 120)));
        debug!(action = %action.display(), ok, "game action");
        let mut failed_goal = false;
        match verdict {
            Verdict::Replace if ok => {
                let mut goal = Goal::new(
                    goal_text.unwrap_or_else(|| action.display()),
                    GoalSource::Director,
                );
                goal.action = Some(action);
                goal.issued_at = Some(Instant::now());
                s.goal = Some(goal);
            }
            Verdict::Step if !instant => {
                if let Some(g) = &mut s.goal {
                    if ok {
                        g.action = Some(action);
                        g.issued_at = Some(Instant::now());
                    } else {
                        g.attempts += 1;
                        failed_goal = g.attempts >= max_attempts;
                    }
                }
            }
            _ => {}
        }
        if failed_goal {
            self.finish_goal(Outcome::Failed(first_line(&text, 60)));
        } else if !ok {
            self.trigger("上一個動作失敗了".to_owned(), false);
        }
    }
}
