//! The model's decision: JSON parsing, prompts and the goal-switching rule.

use std::time::Duration;

use serde_json::{Map, Value};

use crate::config::GameConfig;

/// One adapter action, as sent to `game_<id>_act`.
#[derive(Clone, Debug, PartialEq)]
pub struct ActionCall {
    pub name: String,
    pub args: Map<String, Value>,
}

impl ActionCall {
    pub fn new(name: impl Into<String>, args: Value) -> Self {
        Self {
            name: name.into(),
            args: match args {
                Value::Object(m) => m,
                _ => Map::new(),
            },
        }
    }

    /// Arguments of the act tool.
    pub fn tool_args(&self) -> Value {
        serde_json::json!({ "action": self.name, "args": self.args })
    }

    /// `mine {"block":"iron_ore"}`.
    pub fn display(&self) -> String {
        if self.args.is_empty() {
            self.name.clone()
        } else {
            format!("{} {}", self.name, Value::Object(self.args.clone()))
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportedStatus {
    Working,
    Done,
    Failed,
}

/// A requested mood change (`mood.nudge` payload fields).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MoodNudge {
    pub valence: f32,
    pub arousal: f32,
    pub energy: f32,
    pub reason: String,
}

/// What the model decided.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Decision {
    pub goal: Option<String>,
    pub status: Option<ReportedStatus>,
    pub action: Option<ActionCall>,
    pub commentary: Option<String>,
    pub mood: Option<MoodNudge>,
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "null")
        .map(str::to_owned)
}

fn float(v: Option<&Value>) -> f32 {
    v.and_then(Value::as_f64).unwrap_or(0.0) as f32
}

/// The first JSON object in `raw` (tolerates code fences and chatter).
fn json_object(raw: &str) -> Option<Map<String, Value>> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end < start {
        return None;
    }
    match serde_json::from_str::<Value>(&raw[start..=end]).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

impl Decision {
    /// Parses the model's reply leniently: `action` may be an object
    /// (`{name, args}`), a bare name or `null`.
    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        let Some(obj) = json_object(raw) else {
            anyhow::bail!(
                "not a JSON object: {}",
                raw.chars().take(200).collect::<String>()
            );
        };
        let action = match obj.get("action") {
            Some(Value::String(name)) if !name.trim().is_empty() && name != "null" => {
                Some(ActionCall::new(name.trim(), Value::Null))
            }
            Some(Value::Object(a)) => text(a.get("name").or_else(|| a.get("action")))
                .map(|name| ActionCall::new(name, a.get("args").cloned().unwrap_or(Value::Null))),
            _ => None,
        };
        let status = match text(obj.get("goal_status")).as_deref() {
            Some("done" | "reached" | "complete" | "completed") => Some(ReportedStatus::Done),
            Some("failed" | "fail" | "give_up") => Some(ReportedStatus::Failed),
            Some(_) => Some(ReportedStatus::Working),
            None => None,
        };
        let mood = match obj.get("mood_nudge") {
            Some(Value::Object(m)) => Some(MoodNudge {
                valence: float(m.get("valence")),
                arousal: float(m.get("arousal")),
                energy: float(m.get("energy")),
                reason: text(m.get("reason")).unwrap_or_default(),
            }),
            _ => None,
        };
        Ok(Self {
            goal: text(obj.get("goal")),
            status,
            action,
            commentary: text(obj.get("commentary")),
            mood,
        })
    }
}

/// Where the current goal came from. Viewer and command goals are locked:
/// the model works on them until they are reached or fail.
#[derive(Clone, Debug, PartialEq)]
pub enum GoalSource {
    Director,
    Command { by: String },
    Queue { item: u64, requester: String },
}

impl GoalSource {
    pub fn locked(&self) -> bool {
        !matches!(self, Self::Director)
    }

    /// `(觀眾 Owen 的請求)`-style note, empty for her own goals.
    pub fn note(&self) -> String {
        match self {
            Self::Director => String::new(),
            Self::Command { by } => format!("({by} 指定的)"),
            Self::Queue { requester, .. } => format!("(觀眾 {requester} 的請求)"),
        }
    }
}

/// Inputs of [`judge`] about the current goal.
#[derive(Clone, Debug)]
pub struct GoalFacts<'a> {
    pub text: &'a str,
    pub locked: bool,
    /// No action was issued for it yet.
    pub pending: bool,
    pub action: Option<&'a ActionCall>,
    pub age: Duration,
    pub since_issued: Duration,
}

/// What to do with a proposed action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Run it without touching the goal (instant action or a step of the goal).
    Step,
    /// Run it as the new goal.
    Replace,
    /// Skip it; the reason goes into the trace.
    Keep(&'static str),
}

fn same_text(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.chars()
            .filter(|c| !c.is_whitespace() && !c.is_ascii_punctuation())
            .collect::<String>()
    };
    norm(a) == norm(b)
}

/// The anti-spam rule: let the bot work, switch goals only when the current
/// one finished, the bot is idle, something important happened or the goal is
/// old enough. `busy` is `None` when the adapter does not report it.
pub fn judge(
    cfg: &GameConfig,
    goal: Option<&GoalFacts<'_>>,
    proposal: &ActionCall,
    proposed_goal: Option<&str>,
    busy: Option<bool>,
    important: bool,
) -> Verdict {
    if cfg.instant_actions.contains(&proposal.name) {
        return Verdict::Step;
    }
    let Some(goal) = goal else {
        return Verdict::Replace;
    };
    if goal.pending {
        return Verdict::Step;
    }
    let idle = busy == Some(false);
    let settled = goal.since_issued >= Duration::from_secs(cfg.settle_secs);
    let min_goal = Duration::from_secs(cfg.min_goal_secs);
    if goal.action == Some(proposal) {
        return if idle && settled {
            Verdict::Step
        } else {
            Verdict::Keep("same action, the bot is still on it")
        };
    }
    if goal.locked {
        return if (idle && settled) || important || goal.since_issued >= min_goal {
            Verdict::Step
        } else {
            Verdict::Keep("a requested goal is still running")
        };
    }
    let same_goal = proposed_goal.is_some_and(|g| same_text(g, goal.text));
    if same_goal {
        return if (idle && settled) || important {
            Verdict::Step
        } else {
            Verdict::Keep("same goal, the bot is still on it")
        };
    }
    if (idle && settled) || important || goal.age >= min_goal {
        Verdict::Replace
    } else {
        Verdict::Keep("too soon to switch goals")
    }
}

/// Splits an observation tool result (`summary\n\n狀態:{json}`) into the
/// summary and the parsed state.
pub fn split_observation(text: &str) -> (String, Option<Map<String, Value>>) {
    const MARK: &str = "\n\n狀態:";
    match text.rfind(MARK) {
        Some(i) => {
            let state = serde_json::from_str::<Value>(&text[i + MARK.len()..])
                .ok()
                .and_then(|v| match v {
                    Value::Object(m) => Some(m),
                    _ => None,
                });
            (text[..i].trim().to_owned(), state)
        }
        None => (text.trim().to_owned(), None),
    }
}

/// Parts of the decision prompt.
pub struct PromptParts<'a> {
    pub name: &'a str,
    pub persona: &'a str,
    pub game: &'a str,
    pub act_description: &'a str,
    pub act_parameters: &'a Value,
    pub trigger: &'a str,
    pub goal: Option<String>,
    pub last_action: Option<String>,
    pub backlog: Vec<String>,
    pub recent: Vec<String>,
    pub observation: &'a str,
}

/// System and user messages of one decision.
pub fn prompts(p: &PromptParts<'_>) -> (String, String) {
    let persona = if p.persona.trim().is_empty() {
        String::new()
    } else {
        format!("你的人設(只用來決定風格和偏好):\n{}\n\n", p.persona.trim())
    };
    let system = format!(
        "你是 {name},正在直播玩 {game}。\n\n{persona}\
你現在是遊戲的「慢迴路」:每隔一段時間看一次遊戲狀態,決定高階目標和下一個動作。\
走路、挖掘、戰鬥這些細節交給遊戲裡的 bot(Baritone / AltoClef),你只下高階動作。\n\
規則:\n\
- 目標還在進行(狀態 busy 為 true)而且沒出事,就不要換目標,action 給 null,讓 bot 繼續做。\n\
- 有觀眾或主人指定的目標時,優先把它完成;完成了 goal_status 給 \"done\",做不到給 \"failed\"。\n\
- 危險(血量低、敵人靠近、天黑、掉進岩漿)先求生。\n\
- commentary 是給直播實況的一句提示(等一下要說什麼的方向,照你的個性),沒什麼好說就給 null,不要每次都講。\n\
- mood_nudge 只有真的很開心或很挫折時才給,數值在 -0.1 到 0.1 之間。\n\
只回一個 JSON 物件,不要其他文字:\n\
{{\"goal\": \"目前目標(一句話)\", \"goal_status\": \"working\" | \"done\" | \"failed\", \
\"action\": {{\"name\": \"動作名\", \"args\": {{...}}}} 或 null, \"commentary\": \"實況提示\" 或 null, \
\"mood_nudge\": {{\"valence\": 0.0, \"arousal\": 0.0, \"reason\": \"原因\"}} 或 null}}\n\n\
{actions}\n動作工具的參數 JSON Schema:{schema}",
        name = p.name,
        game = p.game,
        actions = p.act_description,
        schema = p.act_parameters,
    );
    let mut user = format!("觸發:{}\n", p.trigger);
    match &p.goal {
        Some(goal) => user.push_str(&format!("目前目標:{goal}\n")),
        None => user.push_str("目前目標:沒有\n"),
    }
    if let Some(last) = &p.last_action {
        user.push_str(&format!("上一個動作:{last}\n"));
    }
    if !p.backlog.is_empty() {
        user.push_str(&format!("排隊中的觀眾請求:{}\n", p.backlog.join(";")));
    }
    if !p.recent.is_empty() {
        user.push_str("最近發生:\n");
        for line in &p.recent {
            user.push_str(&format!("- {line}\n"));
        }
    }
    user.push_str(&format!("\n遊戲狀態:\n{}", p.observation));
    (system, user)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_lenient_json() {
        let d = Decision::parse(
            "```json\n{\"goal\":\"挖鐵礦\",\"goal_status\":\"working\",\"action\":{\"name\":\"mine\",\"args\":{\"block\":\"iron_ore\"}},\"commentary\":null,\"mood_nudge\":{\"valence\":0.05,\"reason\":\"開心\"}}\n```",
        )
        .unwrap();
        assert_eq!(d.goal.as_deref(), Some("挖鐵礦"));
        assert_eq!(d.status, Some(ReportedStatus::Working));
        assert_eq!(
            d.action,
            Some(ActionCall::new("mine", json!({ "block": "iron_ore" })))
        );
        assert_eq!(d.commentary, None);
        assert_eq!(d.mood.unwrap().valence, 0.05);

        let d = Decision::parse(r#"{"goal":"x","goal_status":"done","action":"stop"}"#).unwrap();
        assert_eq!(d.status, Some(ReportedStatus::Done));
        assert_eq!(d.action.unwrap().name, "stop");
        let d = Decision::parse(r#"{"action":null,"commentary":"  "}"#).unwrap();
        assert!(d.action.is_none() && d.commentary.is_none() && d.goal.is_none());
        assert!(Decision::parse("我不知道").is_err());
    }

    #[test]
    fn splits_observations() {
        let (s, state) = split_observation("血量 20/20\n位置 (1, 2, 3)\n\n狀態:{\"busy\":true}");
        assert_eq!(s, "血量 20/20\n位置 (1, 2, 3)");
        assert_eq!(state.unwrap()["busy"], true);
        let (s, state) = split_observation("沒有連上");
        assert_eq!(s, "沒有連上");
        assert!(state.is_none());
    }

    fn facts<'a>(
        action: Option<&'a ActionCall>,
        locked: bool,
        age: u64,
        since: u64,
    ) -> GoalFacts<'a> {
        GoalFacts {
            text: "挖鐵礦",
            locked,
            pending: action.is_none(),
            action,
            age: Duration::from_secs(age),
            since_issued: Duration::from_secs(since),
        }
    }

    #[test]
    fn goal_switching_rule() {
        let cfg = GameConfig::default();
        let mine = ActionCall::new("mine", json!({ "block": "iron_ore" }));
        let wood = ActionCall::new("mine", json!({ "block": "oak_log" }));
        let chat = ActionCall::new("chat", json!({ "message": "hi" }));
        let busy = Some(true);
        let idle = Some(false);

        assert_eq!(
            judge(&cfg, None, &mine, None, busy, false),
            Verdict::Replace
        );
        assert_eq!(
            judge(
                &cfg,
                Some(&facts(Some(&mine), false, 5, 5)),
                &chat,
                None,
                busy,
                false
            ),
            Verdict::Step
        );
        // A goal without an action yet takes the proposal as its first step.
        assert_eq!(
            judge(
                &cfg,
                Some(&facts(None, true, 1, 1)),
                &mine,
                None,
                busy,
                false
            ),
            Verdict::Step
        );
        // Same action: only re-issued once the bot is idle.
        let current = facts(Some(&mine), false, 30, 30);
        assert!(matches!(
            judge(&cfg, Some(&current), &mine, None, busy, false),
            Verdict::Keep(_)
        ));
        assert_eq!(
            judge(&cfg, Some(&current), &mine, None, idle, false),
            Verdict::Step
        );
        // Different goal: too soon while busy, fine when idle, important or old.
        assert!(matches!(
            judge(&cfg, Some(&current), &wood, Some("砍樹"), busy, false),
            Verdict::Keep(_)
        ));
        assert!(matches!(
            judge(&cfg, Some(&current), &wood, Some("砍樹"), None, false),
            Verdict::Keep(_)
        ));
        assert_eq!(
            judge(&cfg, Some(&current), &wood, Some("砍樹"), idle, false),
            Verdict::Replace
        );
        assert_eq!(
            judge(&cfg, Some(&current), &wood, Some("砍樹"), busy, true),
            Verdict::Replace
        );
        let old = facts(Some(&mine), false, 60, 60);
        assert_eq!(
            judge(&cfg, Some(&old), &wood, Some("砍樹"), busy, false),
            Verdict::Replace
        );
        // Same goal text, different step while busy: keep.
        assert!(matches!(
            judge(&cfg, Some(&current), &wood, Some("挖 鐵礦!"), busy, false),
            Verdict::Keep(_)
        ));
        // Locked goals never get replaced, only stepped.
        let locked = facts(Some(&mine), true, 100, 10);
        assert!(matches!(
            judge(&cfg, Some(&locked), &wood, Some("砍樹"), busy, false),
            Verdict::Keep(_)
        ));
        assert_eq!(
            judge(&cfg, Some(&locked), &wood, Some("砍樹"), idle, false),
            Verdict::Step
        );
        // Just issued: events from the previous goal are not "idle" yet.
        let fresh = facts(Some(&mine), false, 1, 1);
        assert!(matches!(
            judge(&cfg, Some(&fresh), &mine, None, idle, false),
            Verdict::Keep(_)
        ));
    }

    #[test]
    fn prompt_mentions_everything() {
        let schema = json!({ "type": "object" });
        let (system, user) = prompts(&PromptParts {
            name: "DeepSeek醬",
            persona: "傲嬌的鯨魚女孩",
            game: "Minecraft",
            act_description: "可用動作:\n- mine:挖",
            act_parameters: &schema,
            trigger: "定時檢查",
            goal: Some("挖鐵礦(觀眾 Owen 的請求)".into()),
            last_action: Some("mine {} → 成功".into()),
            backlog: vec!["蓋房子(Amy)".into()],
            recent: vec!["死掉了".into()],
            observation: "血量 20/20",
        });
        assert!(system.contains("DeepSeek醬") && system.contains("傲嬌的鯨魚女孩"));
        assert!(system.contains("- mine:挖") && system.contains("\"goal_status\""));
        for part in [
            "定時檢查",
            "挖鐵礦",
            "mine {}",
            "蓋房子",
            "- 死掉了",
            "血量 20/20",
        ] {
            assert!(user.contains(part), "{part} missing in {user}");
        }
    }
}
