use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use miyoria_types::{ContextKey, ContextKind};
use serde::{Deserialize, Serialize};

/// How willing she is to talk in a channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChannelMode {
    /// Never replies.
    Off,
    /// Replies only when directly addressed.
    MentionOnly,
    /// Replies when addressed and sometimes joins in on her own.
    Ambient,
    /// Replies to every turn.
    Always,
}

impl FromStr for ChannelMode {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().replace('_', "-").as_str() {
            "off" => Ok(Self::Off),
            "mention-only" | "mention" => Ok(Self::MentionOnly),
            "ambient" => Ok(Self::Ambient),
            "always" => Ok(Self::Always),
            other => anyhow::bail!("unknown channel mode `{other}`"),
        }
    }
}

impl fmt::Display for ChannelMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Off => "off",
            Self::MentionOnly => "mention-only",
            Self::Ambient => "ambient",
            Self::Always => "always",
        })
    }
}

/// How eagerly she joins conversations she was not addressed in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Activeness {
    Low,
    #[default]
    Medium,
    High,
}

impl Activeness {
    /// Multiplier for the reply probability of ambient turns.
    pub fn probability_factor(self) -> f32 {
        match self {
            Self::Low => 0.5,
            Self::Medium => 1.0,
            Self::High => 1.6,
        }
    }

    /// Multiplier for the ambient cooldown.
    pub fn cooldown_factor(self) -> f32 {
        match self {
            Self::Low => 2.0,
            Self::Medium => 1.0,
            Self::High => 0.5,
        }
    }

    /// Scales an ambient reply probability, clamped to `[0, 1]`.
    pub fn scale(self, probability: f32) -> f32 {
        (probability * self.probability_factor()).clamp(0.0, 1.0)
    }
}

impl FromStr for Activeness {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "low" => Ok(Self::Low),
            "medium" | "normal" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            other => anyhow::bail!("unknown activeness `{other}`"),
        }
    }
}

impl fmt::Display for Activeness {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        })
    }
}

/// `[modules.agent]` config section.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct AgentConfig {
    /// Quiet time after the last message before a turn starts.
    pub debounce_ms: u64,
    /// A typing notification pushes the turn start to at least this far out.
    pub typing_extend_ms: u64,
    /// Upper bound on the total debounce of one turn.
    pub max_debounce_ms: u64,
    /// Messages kept per conversation context.
    pub history_limit: usize,
    /// Messages of history included in the prompt.
    pub prompt_history: usize,
    /// Overrides the profile's `behavior.default_channel_mode`.
    pub default_mode: Option<ChannelMode>,
    /// Per-context modes. Keys are matched against the full context key
    /// (`discord:<guild>:<channel>`), then `<platform>:<guild>`, then the
    /// bare channel id.
    pub channels: HashMap<String, ChannelMode>,
    /// Overrides the profile's `behavior.initiative`.
    pub default_activeness: Option<Activeness>,
    /// Per-context activeness, keyed like `channels`.
    pub activeness: HashMap<String, Activeness>,
    /// Treat messages from other bots as input (they are always recorded).
    pub respond_to_bots: bool,
    /// Reply messages are dropped if not sent within this time.
    pub reply_ttl_ms: u64,
    /// Longer replies are split into several messages.
    pub max_message_chars: usize,
    /// Send direct replies as platform replies to the triggering message.
    pub reply_reference: bool,
    /// The typing indicator is resubmitted this often while generating.
    pub typing_refresh_ms: u64,
    /// Offer registered tools to the model.
    pub tools_enabled: bool,
    /// Rounds of tool calls per turn before she must answer.
    pub max_tool_steps: usize,
    /// Time limit for one tool call.
    pub tool_timeout_ms: u64,
    /// Tool results are truncated to this many characters.
    pub max_tool_result_chars: usize,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// A context with no activity for this long forgets its session.
    pub session_idle_ms: u64,
    /// Seed for the decision sampler; random when unset.
    pub seed: Option<u64>,
    pub attention: AttentionConfig,
    pub voice: VoiceConfig,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            debounce_ms: 1500,
            typing_extend_ms: 2500,
            max_debounce_ms: 4000,
            history_limit: 50,
            prompt_history: 30,
            default_mode: None,
            channels: HashMap::new(),
            default_activeness: None,
            activeness: HashMap::new(),
            respond_to_bots: false,
            reply_ttl_ms: 120_000,
            max_message_chars: 1900,
            reply_reference: false,
            typing_refresh_ms: 8000,
            tools_enabled: true,
            max_tool_steps: 3,
            tool_timeout_ms: 10_000,
            max_tool_result_chars: 1000,
            temperature: None,
            max_tokens: None,
            session_idle_ms: 6 * 3600 * 1000,
            seed: None,
            attention: AttentionConfig::default(),
            voice: VoiceConfig::default(),
        }
    }
}

impl AgentConfig {
    pub fn debounce(&self) -> Duration {
        Duration::from_millis(self.debounce_ms)
    }

    pub fn typing_extend(&self) -> Duration {
        Duration::from_millis(self.typing_extend_ms)
    }

    pub fn max_debounce(&self) -> Duration {
        Duration::from_millis(self.max_debounce_ms.max(self.debounce_ms))
    }

    pub fn reply_ttl(&self) -> Duration {
        Duration::from_millis(self.reply_ttl_ms)
    }

    pub fn session_idle(&self) -> Duration {
        Duration::from_millis(self.session_idle_ms)
    }

    pub fn typing_refresh(&self) -> Duration {
        Duration::from_millis(self.typing_refresh_ms.max(1000))
    }

    pub fn tool_timeout(&self) -> Duration {
        Duration::from_millis(self.tool_timeout_ms)
    }

    /// Mode for `context`, falling back to `default_mode`, then `profile_default`.
    /// Voice contexts fall back to `voice.default_mode` instead.
    pub fn mode_for(&self, context: &ContextKey, profile_default: ChannelMode) -> ChannelMode {
        let configured = lookup(&self.channels, context);
        if context.kind == ContextKind::Voice {
            return configured.unwrap_or(self.voice.default_mode);
        }
        configured.or(self.default_mode).unwrap_or(profile_default)
    }

    /// Activeness for `context`, falling back to `default_activeness`, then
    /// `profile_default`.
    pub fn activeness_for(&self, context: &ContextKey, profile_default: Activeness) -> Activeness {
        lookup(&self.activeness, context)
            .or(self.default_activeness)
            .unwrap_or(profile_default)
    }
}

/// Full context key, then `<platform>:<guild>`, then the bare channel id.
fn lookup<T: Copy>(map: &HashMap<String, T>, context: &ContextKey) -> Option<T> {
    if map.is_empty() {
        return None;
    }
    let scoped = context
        .scope
        .as_ref()
        .map(|s| format!("{}:{s}", context.platform));
    map.get(&context.to_string())
        .or_else(|| scoped.and_then(|s| map.get(&s)))
        .or_else(|| map.get(&context.channel))
        .copied()
}

/// `[modules.agent.attention]`: when she replies.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct AttentionConfig {
    /// Minimum time between her replies to turns that did not address her.
    pub cooldown_ms: u64,
    /// Window (in messages) for the anti-spam share check.
    pub recent_window: usize,
    /// Overrides the profile's `behavior.max_share_of_recent`.
    pub max_share_of_recent: Option<f32>,
    /// Topics that make a message more interesting to her.
    pub keywords: Vec<String>,
    /// Ambient turns scoring below this are ignored.
    pub gray_low: f32,
    /// Ambient turns scoring at least this skip the LLM check.
    pub gray_high: f32,
    /// Reply probability when directly addressed.
    pub direct_probability: f32,
    /// Ask the `fast` model about gray-zone ambient turns.
    pub llm_check: bool,
    pub llm_check_timeout_ms: u64,
    /// Reply probability after the LLM check said yes.
    pub llm_yes_probability: f32,
}

impl Default for AttentionConfig {
    fn default() -> Self {
        Self {
            cooldown_ms: 5000,
            recent_window: 20,
            max_share_of_recent: None,
            keywords: Vec::new(),
            gray_low: 0.3,
            gray_high: 0.6,
            direct_probability: 1.0,
            llm_check: true,
            llm_check_timeout_ms: 8000,
            llm_yes_probability: 0.9,
        }
    }
}

/// `[modules.agent.voice]`: conversation in voice channels. Voice attention is
/// more conservative than text: she mostly listens and only sometimes chimes in.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct VoiceConfig {
    /// Quiet time after an utterance before her turn starts (the speaker may
    /// continue).
    pub debounce_ms: u64,
    /// Upper bound on the debounce of one turn. While someone is speaking the
    /// debounce is extended up to this.
    pub max_debounce_ms: u64,
    /// Mode of voice contexts without a `channels` entry or runtime override.
    pub default_mode: ChannelMode,
    /// Multiplies the reply probability of ambient voice turns.
    pub ambient_factor: f32,
    /// Minimum time between her replies to voice turns that did not address
    /// her, counted from when she last spoke.
    pub cooldown_ms: u64,
    /// Her maximum share of recent voice history for ambient turns.
    pub max_share_of_recent: f32,
    /// A question this soon after she spoke counts as addressed to her.
    pub question_window_ms: u64,
    /// Ask the `fast` model about gray-zone ambient voice turns (adds latency).
    pub llm_check: bool,
    /// Sentences that have not started playing within this time are dropped.
    pub speak_ttl_ms: u64,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            debounce_ms: 700,
            max_debounce_ms: 2500,
            default_mode: ChannelMode::Ambient,
            ambient_factor: 0.5,
            cooldown_ms: 20_000,
            max_share_of_recent: 0.2,
            question_window_ms: 8000,
            llm_check: false,
            speak_ttl_ms: 30_000,
        }
    }
}

impl VoiceConfig {
    pub fn debounce(&self) -> Duration {
        Duration::from_millis(self.debounce_ms)
    }

    pub fn max_debounce(&self) -> Duration {
        Duration::from_millis(self.max_debounce_ms.max(self.debounce_ms))
    }

    pub fn speak_ttl(&self) -> Duration {
        Duration::from_millis(self.speak_ttl_ms)
    }
}

#[cfg(test)]
mod tests {
    use miyoria_types::PlatformId;

    use super::*;

    #[test]
    fn mode_resolution_order() {
        let ctx = ContextKey {
            platform: PlatformId::new("discord"),
            scope: Some("g1".into()),
            channel: "c1".into(),
            kind: ContextKind::Channel,
        };
        let mut cfg = AgentConfig::default();
        assert_eq!(
            cfg.mode_for(&ctx, ChannelMode::Ambient),
            ChannelMode::Ambient
        );
        cfg.default_mode = Some(ChannelMode::MentionOnly);
        assert_eq!(
            cfg.mode_for(&ctx, ChannelMode::Ambient),
            ChannelMode::MentionOnly
        );
        cfg.channels.insert("c1".into(), ChannelMode::Always);
        assert_eq!(
            cfg.mode_for(&ctx, ChannelMode::Ambient),
            ChannelMode::Always
        );
        cfg.channels.insert("discord:g1".into(), ChannelMode::Off);
        assert_eq!(cfg.mode_for(&ctx, ChannelMode::Ambient), ChannelMode::Off);
        cfg.channels
            .insert("discord:g1:c1".into(), ChannelMode::Ambient);
        assert_eq!(cfg.mode_for(&ctx, ChannelMode::Off), ChannelMode::Ambient);
    }

    #[test]
    fn voice_contexts_have_their_own_default_mode() {
        let voice = ContextKey {
            platform: PlatformId::new("discord"),
            scope: Some("g1".into()),
            channel: "v1".into(),
            kind: ContextKind::Voice,
        };
        let mut cfg = AgentConfig {
            default_mode: Some(ChannelMode::Always),
            ..Default::default()
        };
        assert_eq!(cfg.mode_for(&voice, ChannelMode::Off), ChannelMode::Ambient);
        cfg.voice.default_mode = ChannelMode::MentionOnly;
        assert_eq!(
            cfg.mode_for(&voice, ChannelMode::Off),
            ChannelMode::MentionOnly
        );
        cfg.channels.insert("v1".into(), ChannelMode::Off);
        assert_eq!(cfg.mode_for(&voice, ChannelMode::Always), ChannelMode::Off);

        let parsed: AgentConfig = serde_json::from_value(serde_json::json!({
            "voice": { "debounce_ms": 500, "default_mode": "mention-only" }
        }))
        .unwrap();
        assert_eq!(parsed.voice.debounce_ms, 500);
        assert_eq!(parsed.voice.max_debounce_ms, 2500);
        assert_eq!(parsed.voice.default_mode, ChannelMode::MentionOnly);
    }

    #[test]
    fn activeness_resolution_and_scaling() {
        let ctx = ContextKey {
            platform: PlatformId::new("discord"),
            scope: Some("g1".into()),
            channel: "c1".into(),
            kind: ContextKind::Channel,
        };
        let mut cfg = AgentConfig::default();
        assert_eq!(cfg.activeness_for(&ctx, Activeness::Low), Activeness::Low);
        cfg.default_activeness = Some(Activeness::Medium);
        assert_eq!(
            cfg.activeness_for(&ctx, Activeness::Low),
            Activeness::Medium
        );
        cfg.activeness.insert("discord:g1".into(), Activeness::High);
        assert_eq!(cfg.activeness_for(&ctx, Activeness::Low), Activeness::High);

        assert!((Activeness::Low.scale(0.6) - 0.3).abs() < 1e-6);
        assert!((Activeness::Medium.scale(0.6) - 0.6).abs() < 1e-6);
        assert!((Activeness::High.scale(0.8) - 1.0).abs() < 1e-6);
        assert_eq!("HIGH".parse::<Activeness>().unwrap(), Activeness::High);
        assert!("loud".parse::<Activeness>().is_err());
        assert_eq!(Activeness::Low.to_string(), "low");
    }

    #[test]
    fn parses_modes() {
        assert_eq!(
            "mention-only".parse::<ChannelMode>().unwrap(),
            ChannelMode::MentionOnly
        );
        assert_eq!(
            "Mention_Only".parse::<ChannelMode>().unwrap(),
            ChannelMode::MentionOnly
        );
        assert!("loud".parse::<ChannelMode>().is_err());
        let cfg: AgentConfig = serde_json::from_value(serde_json::json!({
            "debounce_ms": 10,
            "channels": { "c": "always" },
            "attention": { "llm_check": false }
        }))
        .unwrap();
        assert_eq!(cfg.debounce_ms, 10);
        assert_eq!(cfg.channels["c"], ChannelMode::Always);
        assert!(!cfg.attention.llm_check);
        assert_eq!(cfg.max_debounce_ms, 4000);
        assert!(cfg.tools_enabled);
        assert_eq!(cfg.max_tool_steps, 3);
    }
}
