use serde::Deserialize;

/// `[modules."platform.discord.bot"]` config section.
///
/// ```toml
/// [modules."platform.discord.bot"]
/// token = "${DISCORD_BOT_TOKEN}"
/// command_guilds = [123456789012345678]
/// self_account_ids = ["234567890123456789"]
/// ```
#[derive(Clone, Debug, Deserialize)]
pub struct DiscordConfig {
    /// Bot token. Keep it in the environment, not in the file.
    pub token: String,
    /// Guilds that get the slash commands (updates apply instantly). Empty
    /// registers them globally, which can take a while to propagate.
    #[serde(default)]
    pub command_guilds: Vec<u64>,
    /// Her other accounts (e.g. the self account used by the voice node).
    /// Mentions of and replies to them count as addressing her.
    #[serde(default)]
    pub self_account_ids: Vec<String>,
}

impl DiscordConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(!self.token.trim().is_empty(), "`token` is empty");
        anyhow::ensure!(
            !self.command_guilds.contains(&0),
            "`command_guilds` contains 0"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_required() {
        assert!(serde_json::from_value::<DiscordConfig>(serde_json::json!({})).is_err());
        let cfg: DiscordConfig =
            serde_json::from_value(serde_json::json!({ "token": "abc" })).unwrap();
        assert!(cfg.validate().is_ok());
        assert!(cfg.command_guilds.is_empty() && cfg.self_account_ids.is_empty());
        let cfg: DiscordConfig =
            serde_json::from_value(serde_json::json!({ "token": " ", "command_guilds": [1] }))
                .unwrap();
        assert!(cfg.validate().is_err());
    }
}
