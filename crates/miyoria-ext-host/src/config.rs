//! `[modules.extensions]` and `[extensions."<id>"]` config sections.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use miyoria_kernel::Config;
use serde::{Deserialize, Serialize};

use crate::manifest::Permissions;

/// `[modules.extensions]`.
///
/// ```toml
/// [modules.extensions]
/// dirs = ["extensions"]
/// dev = true            # restart an extension when its files change
/// ```
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct HostConfig {
    /// Directories searched for extensions. Relative paths are resolved
    /// against the working directory. `ext install` copies into the first.
    pub dirs: Vec<PathBuf>,
    /// Watch extension files and restart on change.
    pub dev: bool,
    pub watch_poll_ms: u64,
    /// `initialize` handshake.
    pub init_timeout_ms: u64,
    /// `tools.call` and `commands.invoke`.
    pub call_timeout_ms: u64,
    /// `prompt.contribute`.
    pub prompt_timeout_ms: u64,
    /// Time an extension gets to exit after `shutdown` before it is killed.
    pub shutdown_grace_ms: u64,
    /// Executables per runtime, e.g. `{ node = "C:/node/node.exe" }`.
    pub runtimes: BTreeMap<String, String>,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            dirs: vec![PathBuf::from("extensions")],
            dev: false,
            watch_poll_ms: 1000,
            init_timeout_ms: 10_000,
            call_timeout_ms: 30_000,
            prompt_timeout_ms: 3_000,
            shutdown_grace_ms: 2_000,
            runtimes: BTreeMap::new(),
        }
    }
}

impl HostConfig {
    pub const SECTION: &'static str = "modules.extensions";

    pub fn from_config(config: &Config) -> anyhow::Result<Self> {
        Ok(config.get(Self::SECTION)?)
    }

    /// `dirs` made absolute against `base`.
    pub fn resolved_dirs(&self, base: &Path) -> Vec<PathBuf> {
        self.dirs
            .iter()
            .map(|d| {
                if d.is_absolute() {
                    d.clone()
                } else {
                    base.join(d)
                }
            })
            .collect()
    }

    /// Executable for a script runtime.
    pub fn runtime_command(&self, runtime: &str) -> String {
        self.runtimes
            .get(runtime)
            .cloned()
            .unwrap_or_else(|| runtime.to_owned())
    }

    pub(crate) fn ms(v: u64) -> Duration {
        Duration::from_millis(v)
    }
}

/// `[extensions."<id>"]`: `enabled`, an optional `permissions` override that
/// can only narrow what the manifest declares, and everything else as the
/// extension's own config.
#[derive(Clone, Debug, Default)]
pub struct ExtensionSettings {
    pub enabled: Option<bool>,
    pub permissions: Option<PermissionOverride>,
    pub config: serde_json::Value,
}

/// Fields present replace (intersect with) the declared permissions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PermissionOverride {
    pub events: Option<Vec<String>>,
    pub tools: Option<bool>,
    pub commands: Option<bool>,
    pub network: Option<Vec<String>>,
    pub input: Option<Vec<String>>,
}

impl ExtensionSettings {
    pub fn from_config(config: &Config, id: &str) -> anyhow::Result<Self> {
        let Some(serde_json::Value::Object(map)) =
            config.section("extensions").and_then(|e| e.get(id))
        else {
            return Ok(Self {
                config: serde_json::Value::Object(Default::default()),
                ..Self::default()
            });
        };
        let mut map = map.clone();
        let enabled = map.remove("enabled").and_then(|v| v.as_bool());
        let permissions = match map.remove("permissions") {
            Some(v) => Some(
                serde_json::from_value(v)
                    .map_err(|e| anyhow::anyhow!("[extensions.\"{id}\"].permissions: {e}"))?,
            ),
            None => None,
        };
        Ok(Self {
            enabled,
            permissions,
            config: serde_json::Value::Object(map),
        })
    }

    /// What the host grants: declared ∩ override. `input` is never granted
    /// unless the override lists it.
    pub fn granted(&self, declared: &Permissions) -> Permissions {
        let o = self.permissions.clone().unwrap_or_default();
        let intersect = |declared: &[String], allowed: &Option<Vec<String>>| match allowed {
            Some(allowed) => declared
                .iter()
                .filter(|d| allowed.contains(d))
                .cloned()
                .collect(),
            None => declared.to_vec(),
        };
        Permissions {
            events: intersect(&declared.events, &o.events),
            tools: declared.tools && o.tools.unwrap_or(true),
            commands: declared.commands && o.commands.unwrap_or(true),
            network: intersect(&declared.network, &o.network),
            input: intersect(&declared.input, &o.input.or_else(|| Some(Vec::new()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_defaults_and_overrides() {
        let cfg = Config::from_toml_str(
            r#"
            [modules.extensions]
            dirs = ["a", "/abs"]
            dev = true
            "#,
        )
        .unwrap();
        let host = HostConfig::from_config(&cfg).unwrap();
        assert!(host.dev);
        assert_eq!(host.init_timeout_ms, 10_000);
        let dirs = host.resolved_dirs(Path::new("/base"));
        assert_eq!(dirs[0], Path::new("/base").join("a"));
        assert_eq!(host.runtime_command("node"), "node");
    }

    #[test]
    fn settings_split_and_grants() {
        let cfg = Config::from_toml_str(
            r#"
            [extensions."x.y"]
            enabled = false
            greeting = "hi"
            [extensions."x.y".permissions]
            events = ["game.*"]
            tools = false
            input = ["mouse"]
            "#,
        )
        .unwrap();
        let s = ExtensionSettings::from_config(&cfg, "x.y").unwrap();
        assert_eq!(s.enabled, Some(false));
        assert_eq!(s.config, serde_json::json!({ "greeting": "hi" }));
        let declared = Permissions {
            events: vec!["game.*".into(), "agent.*".into()],
            tools: true,
            commands: true,
            network: vec!["localhost:1".into()],
            input: vec!["mouse".into(), "keyboard".into()],
        };
        let g = s.granted(&declared);
        assert_eq!(g.events, ["game.*"]);
        assert!(!g.tools && g.commands);
        assert_eq!(g.network, ["localhost:1"]);
        assert_eq!(g.input, ["mouse"]);

        let none = ExtensionSettings::from_config(&cfg, "other").unwrap();
        assert_eq!(none.enabled, None);
        let g = none.granted(&declared);
        assert!(g.input.is_empty());
        assert_eq!(g.events.len(), 2);
    }
}
