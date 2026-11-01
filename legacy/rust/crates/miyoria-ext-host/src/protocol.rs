//! Wire types of the extension protocol (`docs/protocols/extension-rpc.md`).

use miyoria_commands::CommandSpec;
use serde::{Deserialize, Serialize};

use crate::manifest::Permissions;

/// Protocol version sent in `initialize`.
pub const PROTOCOL_VERSION: u32 = 1;

/// `initialize` params (host → extension).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InitializeParams {
    pub protocol: u32,
    pub host: HostInfo,
    pub extension: ExtensionInfo,
    /// `[extensions."<id>"]` without `enabled` / `permissions`.
    pub config: serde_json::Value,
    /// What the host actually grants (declared ∩ config override).
    pub permissions: Permissions,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostInfo {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExtensionInfo {
    pub id: String,
    pub version: String,
    pub dir: String,
    /// Game id owned by a declared game adapter (manifest `game`), else `None`.
    #[serde(default)]
    pub game: Option<String>,
}

/// `initialize` result (extension → host).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct InitializeResult {
    pub contributions: Contributions,
}

/// Everything registered during activation, applied by the host at once.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Contributions {
    pub tools: Vec<ToolDecl>,
    pub commands: Vec<CommandSpec>,
    /// Prompt contributor keys.
    pub prompts: Vec<String>,
    /// Topic patterns to receive as `event` notifications.
    pub subscriptions: Vec<String>,
}

/// `tools.register` params and `contributions.tools` entries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDecl {
    /// Wire name, e.g. `"weather.now"`. Dots become `_` in the agent's tool
    /// registry (`weather_now`) because model APIs reject them.
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments object.
    #[serde(default = "empty_object_schema")]
    pub parameters: serde_json::Value,
    /// Permission node the triggering user needs.
    #[serde(default)]
    pub permission: Option<String>,
}

fn empty_object_schema() -> serde_json::Value {
    serde_json::json!({ "type": "object", "properties": {} })
}

/// Registry name of a tool's wire name.
pub fn registry_tool_name(wire: &str) -> String {
    wire.replace('.', "_")
}

/// Wire names: 1–64 chars of ASCII letters, digits, `_`, `-`, `.`.
pub fn valid_tool_name(wire: &str) -> bool {
    (1..=64).contains(&wire.len())
        && wire
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names() {
        assert!(valid_tool_name("game.minecraft.act"));
        assert_eq!(
            registry_tool_name("game.minecraft.act"),
            "game_minecraft_act"
        );
        assert!(!valid_tool_name("has space"));
        assert!(!valid_tool_name(""));
    }

    #[test]
    fn decl_defaults() {
        let d: ToolDecl =
            serde_json::from_value(serde_json::json!({ "name": "a", "description": "b" })).unwrap();
        assert_eq!(d.parameters["type"], "object");
        let r: InitializeResult = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(r.contributions.tools.is_empty());
    }
}
