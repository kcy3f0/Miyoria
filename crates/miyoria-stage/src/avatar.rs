//! The parts of a profile's `avatar.toml` the Stage uses.

use std::collections::BTreeMap;

use serde::Deserialize;
use tracing::warn;

/// What an emotion maps to in VTube Studio.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AvatarAction {
    /// An expression file (`*.exp3.json`), toggled with `ExpressionActivationRequest`.
    Expression(String),
    /// A hotkey name or id, fired with `HotkeyTriggerRequest`.
    Hotkey(String),
}

impl AvatarAction {
    /// `""` and template placeholders (`<...>`) map to nothing.
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if value.is_empty() || value.starts_with('<') {
            return None;
        }
        if value.to_ascii_lowercase().ends_with(".exp3.json") {
            Some(Self::Expression(value.to_owned()))
        } else {
            Some(Self::Hotkey(value.to_owned()))
        }
    }
}

/// How the mouth is driven.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LipSyncMode {
    /// From playback levels, injected as parameters.
    #[default]
    Inject,
    /// VTube Studio does it from a (virtual) microphone; nothing is injected.
    Mic,
}

/// `avatar.toml`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AvatarProfile {
    /// Expected VTS model name or id (warned about when another is loaded).
    pub vts_model: Option<String>,
    /// Emotion (lowercase) → action. `neutral` is the resting state.
    pub emotions: BTreeMap<String, AvatarAction>,
    pub lipsync: LipSyncMode,
    /// Parameter for mouth opening. Default `MouthOpen`.
    pub mouth_open: String,
    /// Parameter for mouth shape. Default `MouthForm`.
    pub mouth_form: Option<String>,
}

impl Default for AvatarProfile {
    fn default() -> Self {
        Self {
            vts_model: None,
            emotions: BTreeMap::new(),
            lipsync: LipSyncMode::Inject,
            mouth_open: "MouthOpen".to_owned(),
            mouth_form: Some("MouthForm".to_owned()),
        }
    }
}

#[derive(Deserialize, Default)]
struct Raw {
    vts_model: Option<String>,
    #[serde(default)]
    emotion: BTreeMap<String, String>,
    #[serde(default)]
    lipsync: RawLipSync,
}

#[derive(Deserialize, Default)]
struct RawLipSync {
    #[serde(default)]
    mode: LipSyncMode,
    mouth_open: Option<String>,
    mouth_form: Option<String>,
}

impl AvatarProfile {
    /// Parses `avatar.toml` (`None` when the profile has none).
    pub fn parse(table: Option<&toml::Table>) -> anyhow::Result<Self> {
        let raw: Raw = match table {
            Some(t) => toml::Value::Table(t.clone())
                .try_into()
                .map_err(|e| anyhow::anyhow!("invalid avatar.toml: {e}"))?,
            None => Raw::default(),
        };
        let mut emotions = BTreeMap::new();
        for (name, value) in raw.emotion {
            match AvatarAction::parse(&value) {
                Some(action) => {
                    emotions.insert(name.trim().to_lowercase(), action);
                }
                None if value.trim().starts_with('<') => {
                    warn!(emotion = %name, "avatar.toml emotion is still a placeholder");
                }
                None => {}
            }
        }
        let defaults = Self::default();
        let name = |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        Ok(Self {
            vts_model: name(raw.vts_model).filter(|m| !m.starts_with('<')),
            emotions,
            lipsync: raw.lipsync.mode,
            mouth_open: name(raw.lipsync.mouth_open).unwrap_or(defaults.mouth_open),
            mouth_form: match raw.lipsync.mouth_form {
                Some(form) => name(Some(form)),
                None => defaults.mouth_form,
            },
        })
    }

    /// Reads and parses an `avatar.toml` file.
    pub fn load(path: impl AsRef<std::path::Path>) -> anyhow::Result<Self> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("cannot read {}: {e}", path.display()))?;
        let table: toml::Table = toml::from_str(&text)
            .map_err(|e| anyhow::anyhow!("invalid {}: {e}", path.display()))?;
        Self::parse(Some(&table))
    }

    pub fn action_for(&self, emotion: &str) -> Option<&AvatarAction> {
        self.emotions.get(&emotion.trim().to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_deepseek_chan_avatar() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../profiles/deepseek-chan/avatar.toml"
        );
        let p = AvatarProfile::load(path).unwrap();
        // The draft still has placeholders.
        assert_eq!(p.vts_model, None);
        assert!(p.emotions.is_empty());
        assert_eq!(p.lipsync, LipSyncMode::Inject);
        assert_eq!(p.mouth_open, "MouthOpen");
        assert_eq!(p.mouth_form.as_deref(), Some("MouthForm"));
    }

    #[test]
    fn maps_expressions_and_hotkeys() {
        let table: toml::Table = toml::from_str(
            r#"
            vts_model = "DeepSeek-chan"
            [emotion]
            neutral = "Reset"
            Happy = "smile.EXP3.json"
            smug = "Smug Face"
            sad = ""
            [lipsync]
            mode = "mic"
            mouth_form = ""
            "#,
        )
        .unwrap();
        let p = AvatarProfile::parse(Some(&table)).unwrap();
        assert_eq!(p.vts_model.as_deref(), Some("DeepSeek-chan"));
        assert_eq!(
            p.action_for("happy"),
            Some(&AvatarAction::Expression("smile.EXP3.json".into()))
        );
        assert_eq!(
            p.action_for("Smug"),
            Some(&AvatarAction::Hotkey("Smug Face".into()))
        );
        assert_eq!(
            p.action_for("neutral"),
            Some(&AvatarAction::Hotkey("Reset".into()))
        );
        assert_eq!(p.action_for("sad"), None);
        assert_eq!(p.lipsync, LipSyncMode::Mic);
        assert_eq!(p.mouth_form, None);
        assert_eq!(
            AvatarProfile::parse(None).unwrap(),
            AvatarProfile::default()
        );
    }
}
