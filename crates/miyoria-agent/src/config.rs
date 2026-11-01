use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use miyoria_types::ContextKey;
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
    /// Treat messages from other bots as input (they are always recorded).
    pub respond_to_bots: bool,
    /// Reply messages are dropped if not sent within this time.
    pub reply_ttl_ms: u64,
    /// Longer replies are split into several messages.
    pub max_message_chars: usize,
    /// Send direct replies as platform replies to the triggering message.
    pub reply_reference: bool,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// A context with no activity for this long forgets its session.
    pub session_idle_ms: u64,
    /// Seed for the decision sampler; random when unset.
    pub seed: Option<u64>,
    pub attention: AttentionConfig,
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
            respond_to_bots: false,
            reply_ttl_ms: 120_000,
            max_message_chars: 1900,
            reply_reference: false,
            temperature: None,
            max_tokens: None,
            session_idle_ms: 6 * 3600 * 1000,
            seed: None,
            attention: AttentionConfig::default(),
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

    /// Mode for `context`, falling back to `default_mode`, then `profile_default`.
    pub fn mode_for(&self, context: &ContextKey, profile_default: ChannelMode) -> ChannelMode {
        let full = context.to_string();
        let scoped = context
            .scope
            .as_ref()
            .map(|s| format!("{}:{s}", context.platform));
        self.channels
            .get(&full)
            .or_else(|| scoped.and_then(|s| self.channels.get(&s)))
            .or_else(|| self.channels.get(&context.channel))
            .copied()
            .or(self.default_mode)
            .unwrap_or(profile_default)
    }
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

#[cfg(test)]
mod tests {
    use miyoria_types::{ContextKind, PlatformId};

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
    }
}
