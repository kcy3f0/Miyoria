//! Game director (module `game`): the slow loop of `docs/ARCHITECTURE.md`
//! §12.3.
//!
//! A game adapter extension (e.g. `extensions/minecraft/adapter`) exposes the
//! tools `game_<id>_observe` / `game_<id>_act` and publishes `game.<id>.*`
//! events. While a session runs (`game start`), the director:
//!
//! - every `decide_secs` (sooner on trigger events) observes the game, asks
//!   the LLM purpose `game` (JSON mode) for `{goal, goal_status, action,
//!   commentary, mood_nudge}` and runs the action through the act tool;
//! - keeps the current goal and lets the bot work: goals are only replaced
//!   when finished, failed, idle, old enough or after something important;
//! - turns `queue.item_activated` items of kind `game_goal` into locked
//!   goals and completes / skips them on the [`RequestQueue`] when reached
//!   (`goal_reached` / `baritone_idle` events or the model's `goal_status`)
//!   or failed;
//! - requests live commentary with `agent.initiative` (reason `game`) in the
//!   session's context, at most every `commentary_min_secs`; deaths,
//!   achievements, viewer goals and other important events go out at once;
//! - publishes `mood.nudge` on deaths and achievements, and the decision
//!   trace on `game.director.decision`;
//! - contributes a `game` prompt section so normal replies know what she is
//!   doing, and provides [`GameHandle`].
//!
//! Services: `Arc<ToolRegistry>` (required to play), `Arc<LlmRouter>`,
//! `Arc<RequestQueue>`, `Arc<CommandRegistry>`, `Arc<PromptContributors>`
//! (all optional).

pub mod commands;
pub mod config;
pub mod decision;
pub mod director;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use async_trait::async_trait;
use miyoria_commands::CommandRegistry;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest, TopicFilter};
use miyoria_profile::Profile;
use miyoria_types::{PromptContributor, PromptContributors, PromptRequest, PromptSection};
use parking_lot::Mutex;
use tokio::sync::mpsc;

pub use config::{GameConfig, GamePermissions};
pub use decision::{ActionCall, Decision, GoalSource, Verdict, judge};
pub use director::{DECISION_TOPIC, GameStatus, GoalView, INITIATIVE_REASON, Persona};

use director::{Director, View};

/// Prompt contributor key.
pub const PROMPT_KEY: &str = "game";

/// Read access to the running session (service `Arc<GameHandle>`).
pub struct GameHandle {
    view: View,
}

impl GameHandle {
    /// `None` while not playing.
    pub fn status(&self) -> Option<GameStatus> {
        self.view.lock().clone()
    }
}

struct Running {
    commands: Option<(Arc<CommandRegistry>, Vec<String>)>,
    prompts: Option<Arc<PromptContributors>>,
}

/// Module `game`.
pub struct GameModule {
    manifest: ModuleManifest,
    persona: Persona,
    running: Mutex<Option<Running>>,
}

impl GameModule {
    pub const ID: &'static str = "game";

    /// `name` and `persona` flavour the decisions (the persona is cut to
    /// `persona_chars`).
    pub fn new(name: impl Into<String>, persona: impl Into<String>) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Game director")
                .description(
                    "Slow loop: picks game goals, acts through game adapters, comments live",
                )
                .optional("llm")
                .optional("commands")
                .optional("queue")
                .optional("extensions"),
            persona: Persona {
                name: name.into(),
                text: persona.into(),
            },
            running: Mutex::new(None),
        }
    }

    pub fn from_profile(profile: &Profile) -> Self {
        Self::new(profile.display_name(), profile.persona_prompt())
    }
}

struct GamePrompt {
    view: View,
    summary_chars: usize,
}

#[async_trait]
impl PromptContributor for GamePrompt {
    fn key(&self) -> &str {
        PROMPT_KEY
    }

    async fn contribute(&self, _request: &PromptRequest) -> anyhow::Result<Vec<PromptSection>> {
        let Some(s) = self.view.lock().clone() else {
            return Ok(Vec::new());
        };
        let mut body = format!(
            "你正在直播玩 {},聊天時可以自然提到遊戲裡的狀況。",
            s.game_name
        );
        match &s.goal {
            Some(g) => body.push_str(&format!("\n目前目標:{}{}", g.text, g.note)),
            None => body.push_str("\n目前沒有特定目標。"),
        }
        if !s.backlog.is_empty() {
            body.push_str(&format!("\n排隊中的觀眾請求:{}", s.backlog.join("、")));
        }
        if let Some(last) = s
            .recent
            .iter()
            .rev()
            .take(3)
            .rev()
            .cloned()
            .reduce(|a, b| format!("{a};{b}"))
        {
            body.push_str(&format!("\n剛剛:{last}"));
        }
        if !s.summary.is_empty() {
            let summary: String = s.summary.chars().take(self.summary_chars).collect();
            body.push_str(&format!("\n遊戲狀態:\n{summary}"));
        }
        Ok(vec![PromptSection {
            key: PROMPT_KEY.to_owned(),
            title: "你正在玩的遊戲".to_owned(),
            body,
            order: 45,
        }])
    }
}

#[async_trait]
impl Module for GameModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let cfg: GameConfig = ctx.config()?;
        let cfg = Arc::new(cfg);
        let view: View = Arc::new(Mutex::new(None));
        let (tx, rx) = mpsc::unbounded_channel();

        let commands = match ctx.services().get::<CommandRegistry>() {
            Some(registry) => {
                let paths = commands::register(
                    &registry,
                    &cfg.permissions,
                    &cfg.default_game,
                    tx.clone(),
                    view.clone(),
                )?;
                Some((registry, paths))
            }
            None => None,
        };
        let prompts = ctx.services().get::<PromptContributors>();
        if let Some(p) = &prompts {
            p.register(Arc::new(GamePrompt {
                view: view.clone(),
                summary_chars: cfg.prompt_summary_chars,
            }));
        }
        ctx.provide(Arc::new(GameHandle { view: view.clone() }));
        // Commands keep a sender, so the channel lives as long as the module.
        ctx.provide(Arc::new(GameControl { tx }));

        let mut persona = self.persona.clone();
        persona.text = persona.text.chars().take(cfg.persona_chars).collect();
        let events = ctx.subscribe(TopicFilter::new([
            "game.*",
            "queue.item_activated",
            "voice.joined",
            "voice.left",
            "voice.participants",
        ]));
        let director = Director::new(cfg, ctx.clone(), persona, view);
        ctx.spawn("director", director.run(events, rx));
        *self.running.lock() = Some(Running { commands, prompts });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        if let Some(r) = self.running.lock().take() {
            if let Some((registry, paths)) = r.commands {
                for path in paths {
                    registry.unregister(&path);
                }
            }
            if let Some(p) = r.prompts {
                p.unregister(PROMPT_KEY);
            }
        }
        Ok(())
    }
}

/// Programmatic control of the director (service `Arc<GameControl>`), for
/// the Admin API or tests: the same operations as the commands.
pub struct GameControl {
    tx: mpsc::UnboundedSender<director::Control>,
}

impl GameControl {
    async fn ask(
        &self,
        make: impl FnOnce(tokio::sync::oneshot::Sender<Result<String, String>>) -> director::Control,
    ) -> Result<String, String> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(make(reply))
            .map_err(|_| "遊戲模組沒在跑。".to_owned())?;
        rx.await.map_err(|_| "遊戲模組沒有回應。".to_owned())?
    }

    /// Starts a session in `context` (used as-is), acting for `account`.
    pub async fn start(
        &self,
        game: &str,
        context: miyoria_types::ContextKey,
        account: miyoria_types::AccountRef,
    ) -> Result<String, String> {
        self.ask(|reply| director::Control::Start {
            game: game.to_owned(),
            placement: director::Placement::Here,
            here: context,
            invoker: account,
            reply,
        })
        .await
    }

    pub async fn stop(&self) -> Result<String, String> {
        self.ask(|reply| director::Control::Stop { reply }).await
    }

    pub async fn goal(&self, text: &str, by: &str) -> Result<String, String> {
        self.ask(|reply| director::Control::Goal {
            text: text.to_owned(),
            by: by.to_owned(),
            reply,
        })
        .await
    }
}
