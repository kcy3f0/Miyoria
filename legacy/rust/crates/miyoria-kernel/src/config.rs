//! `miyoria.toml` loading.
//!
//! String values may reference environment variables as `${NAME}` or
//! `${NAME:-default}`, so secrets can stay in `.env` / the environment.

use std::path::Path;

use serde::de::DeserializeOwned;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read config file `{path}`: {source}")]
    Read {
        path: String,
        source: std::io::Error,
    },
    #[error("invalid TOML: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("environment variable `{0}` is not set")]
    MissingEnv(String),
    #[error("invalid config at `{path}`: {message}")]
    Invalid { path: String, message: String },
}

/// The whole config tree, kept as JSON so each module can deserialize its own
/// section with its own types.
#[derive(Clone, Debug, Default)]
pub struct Config {
    root: serde_json::Value,
}

impl Config {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.display().to_string(),
            source,
        })?;
        Self::from_toml_str(&text)
    }

    pub fn from_toml_str(text: &str) -> Result<Self, ConfigError> {
        let value: toml::Value = toml::from_str(text)?;
        let mut root = serde_json::to_value(value).map_err(|e| ConfigError::Invalid {
            path: String::new(),
            message: e.to_string(),
        })?;
        interpolate(&mut root, &|name| std::env::var(name).ok())?;
        Ok(Self { root })
    }

    pub fn from_value(root: serde_json::Value) -> Self {
        Self { root }
    }

    pub fn raw(&self) -> &serde_json::Value {
        &self.root
    }

    /// Section at a dotted path, e.g. `"llm"` or `"modules.agent"`.
    pub fn section(&self, path: &str) -> Option<&serde_json::Value> {
        path.split('.').try_fold(&self.root, |v, key| v.get(key))
    }

    /// Deserializes a section; a missing section deserializes from `{}`.
    pub fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, ConfigError> {
        let value = self
            .section(path)
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
        serde_json::from_value(value).map_err(|e| ConfigError::Invalid {
            path: path.to_owned(),
            message: e.to_string(),
        })
    }

    /// `(enabled, config)` for `[modules.<id>]`. Modules are enabled unless
    /// `enabled = false` is set.
    pub fn module(&self, id: &str) -> (bool, serde_json::Value) {
        let Some(serde_json::Value::Object(map)) = self.section("modules").and_then(|m| m.get(id))
        else {
            return (true, serde_json::Value::Null);
        };
        let mut map = map.clone();
        let enabled = map
            .remove("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        (enabled, serde_json::Value::Object(map))
    }
}

fn interpolate(
    value: &mut serde_json::Value,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<(), ConfigError> {
    match value {
        serde_json::Value::String(s) if s.contains("${") => {
            *s = expand(s, env)?;
        }
        serde_json::Value::Array(items) => {
            for item in items {
                interpolate(item, env)?;
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                interpolate(item, env)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn expand(s: &str, env: &dyn Fn(&str) -> Option<String>) -> Result<String, ConfigError> {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let expr = &after[..end];
        let (name, default) = match expr.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (expr, None),
        };
        match (env(name), default) {
            (Some(v), _) if !v.is_empty() => out.push_str(&v),
            (_, Some(d)) => out.push_str(d),
            (Some(v), None) => out.push_str(&v),
            (None, None) => return Err(ConfigError::MissingEnv(name.to_owned())),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_env_references() {
        let env = |name: &str| (name == "KEY").then(|| "secret".to_owned());
        assert_eq!(expand("a-${KEY}-b", &env).unwrap(), "a-secret-b");
        assert_eq!(expand("${NOPE:-fallback}", &env).unwrap(), "fallback");
        assert!(matches!(
            expand("${NOPE}", &env),
            Err(ConfigError::MissingEnv(_))
        ));
    }

    #[test]
    fn module_sections() {
        let cfg = Config::from_toml_str(
            r#"
            [modules.agent]
            enabled = false
            debounce_ms = 1500
            "#,
        )
        .unwrap();
        let (enabled, section) = cfg.module("agent");
        assert!(!enabled);
        assert_eq!(section["debounce_ms"], 1500);
        assert!(cfg.module("other").0);
    }
}
