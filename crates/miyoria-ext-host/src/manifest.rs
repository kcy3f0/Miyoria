//! `miyoria.extension.toml` (see `docs/ARCHITECTURE.md` §9.2).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File name of an extension manifest.
pub const MANIFEST_FILE: &str = "miyoria.extension.toml";

/// Contribution kinds the host knows about. Unknown kinds only warn.
pub const KNOWN_KINDS: &[&str] = &[
    "module",
    "tools",
    "commands",
    "events",
    "prompt",
    "game-adapter",
    "provider",
    "panel",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionManifest {
    /// Globally unique id, e.g. `"miyoria.minecraft"`.
    pub id: String,
    pub version: String,
    /// Human-readable name; defaults to the id.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// What the extension contributes. Accepts a string or a list.
    #[serde(default, deserialize_with = "one_or_many")]
    pub kind: Vec<String>,
    pub runtime: Runtime,
    /// Entry point relative to the extension directory (script or binary).
    pub entry: String,
    #[serde(default)]
    pub placement: Placement,
    #[serde(default)]
    pub permissions: Permissions,
    #[serde(default)]
    pub config: ConfigSection,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerSpec>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    Node,
    Deno,
    Bun,
    Binary,
}

/// Which node runs the extension. The core host runs `core` and `any`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    #[default]
    Core,
    Stage,
    Any,
}

impl Placement {
    pub fn runs_on_core(self) -> bool {
        matches!(self, Self::Core | Self::Any)
    }
}

/// Declared permissions. The host grants at most these.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Permissions {
    /// Topic patterns the extension may subscribe to and publish on
    /// (`"game.*"`, `"agent.turn.completed"`, `"*"`).
    pub events: Vec<String>,
    /// May register tools for the agent.
    pub tools: bool,
    /// May register commands.
    pub commands: bool,
    /// Hosts the extension talks to (informational; not sandboxed).
    pub network: Vec<String>,
    /// High-risk input simulation (keyboard, mouse, ...). Granted only when
    /// also listed in the config override.
    pub input: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ConfigSection {
    /// JSON Schema file of the extension config, relative to its directory.
    pub schema: Option<String>,
}

/// An MCP server bundled with the extension. Parsed and exposed only; the MCP
/// module decides what to do with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerSpec {
    pub name: String,
    /// stdio transport.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Streamable HTTP transport.
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("cannot read `{path}`: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid manifest `{path}`: {message}")]
    Parse { path: PathBuf, message: String },
}

impl ExtensionManifest {
    /// Reads `<dir>/miyoria.extension.toml`.
    pub fn load(dir: &Path) -> Result<Self, ManifestError> {
        let path = dir.join(MANIFEST_FILE);
        let text = std::fs::read_to_string(&path).map_err(|source| ManifestError::Read {
            path: path.clone(),
            source,
        })?;
        Self::parse(&text).map_err(|message| ManifestError::Parse { path, message })
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        toml::from_str(text).map_err(|e| e.to_string())
    }

    pub fn display_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.id)
    }

    /// Supervisor module id of this extension: `ext.<id>`.
    pub fn module_id(&self) -> String {
        format!("ext.{}", self.id)
    }

    /// Problems that make the manifest unusable (independent of the files).
    pub fn errors(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if !valid_id(&self.id) {
            errors.push(format!(
                "id `{}` must be 1-64 chars of lowercase letters, digits, `.`, `-` or `_`",
                self.id
            ));
        }
        if self.version.trim().is_empty() {
            errors.push("version is empty".to_owned());
        }
        if self.entry.trim().is_empty() {
            errors.push("entry is empty".to_owned());
        }
        for pattern in &self.permissions.events {
            if !valid_pattern(pattern) {
                errors.push(format!("invalid event pattern `{pattern}`"));
            }
        }
        for server in &self.mcp_servers {
            if server.command.is_none() == server.url.is_none() {
                errors.push(format!(
                    "mcp server `{}` needs exactly one of `command` or `url`",
                    server.name
                ));
            }
        }
        errors
    }

    /// Suspicious but usable settings.
    pub fn warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        for kind in &self.kind {
            if !KNOWN_KINDS.contains(&kind.as_str()) {
                warnings.push(format!("unknown kind `{kind}`"));
            }
        }
        if self.kind.is_empty() {
            warnings.push("no `kind` declared".to_owned());
        }
        if self.kind.iter().any(|k| k == "tools") && !self.permissions.tools {
            warnings.push("kind `tools` without `permissions.tools = true`".to_owned());
        }
        if self.kind.iter().any(|k| k == "commands") && !self.permissions.commands {
            warnings.push("kind `commands` without `permissions.commands = true`".to_owned());
        }
        if !self.permissions.input.is_empty() {
            warnings.push(format!(
                "requests high-risk input permissions: {}",
                self.permissions.input.join(", ")
            ));
        }
        warnings
    }
}

/// Extension ids: lowercase ASCII letters, digits, `.`, `-`, `_`.
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'))
        && !id.starts_with('.')
        && !id.ends_with('.')
}

/// Topic patterns: `*`, `a.b`, or `a.b.*`.
pub fn valid_pattern(pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let body = pattern.strip_suffix(".*").unwrap_or(pattern);
    valid_topic(body)
}

/// Concrete topics: non-empty dotted segments of `[a-z0-9_-]`.
pub fn valid_topic(topic: &str) -> bool {
    topic.len() <= 128
        && topic.split('.').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'))
        })
}

fn one_or_many<'de, D>(de: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    Ok(match OneOrMany::deserialize(de)? {
        OneOrMany::One(s) => vec![s],
        OneOrMany::Many(v) => v,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"
        id = "miyoria.minecraft"
        version = "0.1.0"
        kind = ["game-adapter", "tools", "commands"]
        runtime = "node"
        entry = "dist/index.js"
        placement = "stage"

        [permissions]
        events = ["game.*", "agent.turn.completed"]
        tools = true
        commands = true
        network = ["localhost:25565"]
        input = []

        [config]
        schema = "config.schema.json"

        [[mcp_servers]]
        name = "mc-wiki"
        command = "npx"
        args = ["-y", "some-minecraft-wiki-mcp"]
    "#;

    #[test]
    fn parses_architecture_example() {
        let m = ExtensionManifest::parse(FULL).unwrap();
        assert_eq!(m.id, "miyoria.minecraft");
        assert_eq!(m.runtime, Runtime::Node);
        assert_eq!(m.placement, Placement::Stage);
        assert!(!m.placement.runs_on_core());
        assert_eq!(m.permissions.events.len(), 2);
        assert_eq!(m.config.schema.as_deref(), Some("config.schema.json"));
        assert_eq!(m.mcp_servers[0].args, ["-y", "some-minecraft-wiki-mcp"]);
        assert_eq!(m.module_id(), "ext.miyoria.minecraft");
        assert!(m.errors().is_empty());
        assert!(m.warnings().is_empty());
    }

    #[test]
    fn single_kind_and_defaults() {
        let m = ExtensionManifest::parse(
            "id = \"x\"\nversion = \"1\"\nkind = \"module\"\nruntime = \"binary\"\nentry = \"x.exe\"",
        )
        .unwrap();
        assert_eq!(m.kind, ["module"]);
        assert_eq!(m.placement, Placement::Core);
        assert!(!m.permissions.tools);
    }

    #[test]
    fn reports_errors_and_warnings() {
        let m = ExtensionManifest::parse(
            r#"
            id = "Bad Id"
            version = ""
            kind = ["tools", "teleport"]
            runtime = "node"
            entry = "index.js"
            [permissions]
            events = ["Game.*", "game.**"]
            input = ["mouse"]
            "#,
        )
        .unwrap();
        let errors = m.errors();
        assert_eq!(errors.len(), 4, "{errors:?}");
        let warnings = m.warnings();
        assert_eq!(warnings.len(), 3, "{warnings:?}");
        assert!(ExtensionManifest::parse("id = \"x\"").is_err());
    }

    #[test]
    fn patterns() {
        assert!(valid_pattern("*"));
        assert!(valid_pattern("game.*"));
        assert!(valid_pattern("agent.turn.completed"));
        assert!(!valid_pattern("game*"));
        assert!(!valid_pattern("*.x"));
        assert!(!valid_pattern(""));
        assert!(valid_topic("ext.miyoria.hello.ping"));
        assert!(!valid_topic("a..b"));
    }
}
