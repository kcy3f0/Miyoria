//! A *profile* is one complete character: persona prompts, which LLM it uses,
//! voice and avatar settings. The persona prompts inside a profile can be
//! edited without touching the rest.
//!
//! ```text
//! profiles/<id>/
//!   profile.toml
//!   persona/
//!     identity.md        # sections, in the order listed in profile.toml
//!     style.md
//!     examples/*.md      # few-shot dialogues
//!   voice.toml
//!   avatar.toml
//! ```

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;
use miyoria_types::ProfileId;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct ProfileManifest {
    pub id: String,
    pub display_name: String,
    /// Names that count as addressing her directly.
    #[serde(default)]
    pub nicknames: Vec<String>,
    /// Topics she cares about; they make ambient messages more interesting.
    #[serde(default)]
    pub interests: Vec<String>,
    #[serde(default)]
    pub language: LanguageConfig,
    #[serde(default)]
    pub mood: MoodBaseline,
    #[serde(default)]
    pub behavior: BehaviorConfig,
    #[serde(default)]
    pub persona: PersonaConfig,
    #[serde(default)]
    pub llm: ProfileLlm,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct LanguageConfig {
    pub primary: String,
    pub secondary: Vec<String>,
}

impl Default for LanguageConfig {
    fn default() -> Self {
        Self {
            primary: "zh-TW".into(),
            secondary: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct MoodBaseline {
    /// -1..1
    pub valence: f32,
    /// 0..1
    pub arousal: f32,
    /// 0..1
    pub energy: f32,
}

impl Default for MoodBaseline {
    fn default() -> Self {
        Self {
            valence: 0.0,
            arousal: 0.5,
            energy: 0.7,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct BehaviorConfig {
    /// `off` | `mention-only` | `ambient` | `always`
    pub default_channel_mode: String,
    /// `low` | `medium` | `high`
    pub initiative: String,
    /// Max share of recent messages that may be hers (anti-spam).
    pub max_share_of_recent: f32,
}

impl Default for BehaviorConfig {
    fn default() -> Self {
        Self {
            default_channel_mode: "mention-only".into(),
            initiative: "medium".into(),
            max_share_of_recent: 0.3,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct PersonaConfig {
    /// Section files under `persona/`, in prompt order (without `.md`).
    pub sections: Vec<String>,
}

impl Default for PersonaConfig {
    fn default() -> Self {
        Self {
            sections: vec!["identity".into(), "style".into()],
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ProfileLlm {
    /// Purpose → `provider:model` chain, overriding the global `[llm.purposes]`.
    pub purposes: HashMap<String, Vec<String>>,
}

#[derive(Clone, Debug)]
pub struct PersonaSection {
    pub key: String,
    pub body: String,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub id: ProfileId,
    pub dir: PathBuf,
    pub manifest: ProfileManifest,
    pub sections: Vec<PersonaSection>,
    pub examples: Vec<String>,
    pub voice: Option<toml::Table>,
    pub avatar: Option<toml::Table>,
}

impl Profile {
    /// Loads `profiles_dir/<id>`.
    pub fn load(profiles_dir: impl AsRef<Path>, id: &str) -> anyhow::Result<Self> {
        Self::load_dir(profiles_dir.as_ref().join(id))
    }

    pub fn load_dir(dir: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let dir = dir.into();
        let manifest_path = dir.join("profile.toml");
        let manifest: ProfileManifest = toml::from_str(
            &fs::read_to_string(&manifest_path)
                .with_context(|| format!("reading {}", manifest_path.display()))?,
        )
        .with_context(|| format!("parsing {}", manifest_path.display()))?;

        let persona_dir = dir.join("persona");
        let mut sections = Vec::new();
        for key in &manifest.persona.sections {
            let path = persona_dir.join(format!("{key}.md"));
            let body = fs::read_to_string(&path)
                .with_context(|| format!("reading persona section {}", path.display()))?;
            sections.push(PersonaSection {
                key: key.clone(),
                body: body.trim().to_owned(),
            });
        }

        let mut examples = Vec::new();
        let examples_dir = persona_dir.join("examples");
        if examples_dir.is_dir() {
            let mut paths: Vec<_> = fs::read_dir(&examples_dir)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "md"))
                .collect();
            paths.sort();
            for path in paths {
                examples.push(fs::read_to_string(&path)?.trim().to_owned());
            }
        }

        Ok(Self {
            id: ProfileId(manifest.id.clone()),
            voice: read_optional_table(&dir.join("voice.toml"))?,
            avatar: read_optional_table(&dir.join("avatar.toml"))?,
            dir,
            manifest,
            sections,
            examples,
        })
    }

    pub fn display_name(&self) -> &str {
        &self.manifest.display_name
    }

    /// Display name plus nicknames, for "is she being addressed" checks.
    pub fn names(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.manifest.display_name.as_str())
            .chain(self.manifest.nicknames.iter().map(String::as_str))
    }

    /// Replaces a persona section's text (runtime edit, e.g. from the panel).
    pub fn set_section(&mut self, key: &str, body: impl Into<String>) {
        let body = body.into();
        match self.sections.iter_mut().find(|s| s.key == key) {
            Some(s) => s.body = body,
            None => self.sections.push(PersonaSection {
                key: key.to_owned(),
                body,
            }),
        }
    }

    /// Stable persona prompt (sections + examples). Kept free of anything that
    /// changes per turn so providers can cache it as a prefix.
    pub fn persona_prompt(&self) -> String {
        let mut out = String::new();
        for s in &self.sections {
            out.push_str(&s.body);
            out.push_str("\n\n");
        }
        if !self.examples.is_empty() {
            out.push_str("# 範例對話(只示範語氣,不要照抄)\n\n");
            for e in &self.examples {
                out.push_str(e);
                out.push_str("\n\n");
            }
        }
        out.trim_end().to_owned()
    }
}

fn read_optional_table(path: &Path) -> anyhow::Result<Option<toml::Table>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    Ok(Some(
        toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interests_default_to_empty() {
        let m: ProfileManifest = toml::from_str("id = \"x\"\ndisplay_name = \"X\"").unwrap();
        assert!(m.interests.is_empty());
        let m: ProfileManifest =
            toml::from_str("id = \"x\"\ndisplay_name = \"X\"\ninterests = [\"海\"]").unwrap();
        assert_eq!(m.interests, ["海"]);
    }

    #[test]
    fn loads_the_bundled_profile() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../profiles");
        let p = Profile::load(dir, "deepseek-chan").unwrap();
        assert_eq!(p.id.as_str(), "deepseek-chan");
        assert!(p.manifest.interests.iter().any(|i| i == "鯨魚"));
        assert!(!p.persona_prompt().is_empty());
    }
}
