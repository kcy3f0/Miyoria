//! `[modules.voice]` config and the profile's `voice.toml`.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::consent::ConsentPolicy;
use crate::segment::SegmenterConfig;

/// What happens when someone talks over her.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BargeInMode {
    /// Fade out and stop the current playback.
    #[default]
    Stop,
    /// Keep talking (e.g. while streaming).
    Ignore,
}

/// `[modules.voice]` config section.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct VoiceConfig {
    /// `opt-out` (default): listen unless a user opted out. `opt-in`: only
    /// users who opted in.
    pub consent: ConsentPolicy,
    /// Low energy for this long ends an utterance. Default 600.
    pub end_silence_ms: u32,
    /// Utterances are cut at this length. Default 15 000.
    pub max_utterance_ms: u32,
    /// Shorter utterances are dropped. Default 300.
    pub min_utterance_ms: u32,
    /// Utterances with less voiced audio are dropped. Default 200.
    pub min_voiced_ms: u32,
    /// Convert transcripts to Traditional Chinese (Taiwan). Default true.
    pub to_traditional: bool,
    /// Concurrent ASR requests across speakers. Default 2.
    pub asr_concurrency: usize,
    /// ASR language hint (`zh`, ...). Default auto-detect.
    pub asr_language: Option<String>,
    /// Vocabulary hint for ASR (her name, nicknames, game terms).
    pub asr_prompt: Option<String>,
    /// Append the display names of people in the channel to the ASR prompt.
    /// Default false.
    pub asr_prompt_participants: bool,
    /// Extra hallucination phrases to drop (substring match).
    pub hallucinations: Vec<String>,
    /// Barge-in behaviour. Default `stop`.
    pub barge_in: BargeInMode,
    /// Someone must talk this long over her before she stops. Default 600.
    pub barge_in_ms: u32,
    /// Fade-out when stopping for barge-in. Default 150.
    pub barge_in_fade_ms: u32,
    /// Language hint sent to TTS. Default `Chinese`.
    pub tts_language: String,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            consent: ConsentPolicy::OptOut,
            end_silence_ms: 600,
            max_utterance_ms: 15_000,
            min_utterance_ms: 300,
            min_voiced_ms: 200,
            to_traditional: true,
            asr_concurrency: 2,
            asr_language: None,
            asr_prompt: None,
            asr_prompt_participants: false,
            hallucinations: Vec::new(),
            barge_in: BargeInMode::Stop,
            barge_in_ms: 600,
            barge_in_fade_ms: 150,
            tts_language: "Chinese".to_owned(),
        }
    }
}

impl VoiceConfig {
    pub fn segmenter(&self) -> SegmenterConfig {
        SegmenterConfig {
            end_silence_ms: self.end_silence_ms.max(20),
            max_utterance_ms: self.max_utterance_ms.max(500),
            min_utterance_ms: self.min_utterance_ms,
            min_voiced_ms: self.min_voiced_ms,
            ..SegmenterConfig::default()
        }
    }
}

/// The parts of a profile's `voice.toml` this module uses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VoiceProfile {
    /// Preferred TTS provider kind (informational; the speech fallback chain
    /// decides which provider runs).
    pub provider: Option<String>,
    /// Voice name registered with the TTS worker. Defaults to the profile id.
    pub voice: String,
    /// The profile has a cloned voice (`[clone]`).
    pub cloned: bool,
    /// `[emotion.instruct]`: emotion → style instruction.
    pub instruct: BTreeMap<String, String>,
}

#[derive(Deserialize, Default)]
struct RawProfile {
    provider: Option<String>,
    voice: Option<String>,
    clone: Option<toml::Table>,
    #[serde(default)]
    emotion: RawEmotion,
}

#[derive(Deserialize, Default)]
struct RawEmotion {
    #[serde(default)]
    instruct: BTreeMap<String, String>,
}

impl VoiceProfile {
    /// Parses `voice.toml` (`None` when the profile has none).
    pub fn parse(profile_id: &str, table: Option<&toml::Table>) -> anyhow::Result<Self> {
        let raw: RawProfile = match table {
            Some(t) => toml::Value::Table(t.clone())
                .try_into()
                .map_err(|e| anyhow::anyhow!("invalid voice.toml: {e}"))?,
            None => RawProfile::default(),
        };
        let voice = raw
            .voice
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| profile_id.to_owned());
        Ok(Self {
            provider: raw.provider,
            voice,
            cloned: raw.clone.is_some(),
            instruct: raw
                .emotion
                .instruct
                .into_iter()
                .map(|(k, v)| (k.to_lowercase(), v.trim().to_owned()))
                .collect(),
        })
    }

    /// Style instruction for `emotion`, if the profile defines one.
    pub fn instruct_for(&self, emotion: Option<&str>) -> Option<String> {
        let emotion = emotion?.trim().to_lowercase();
        self.instruct
            .get(&emotion)
            .filter(|s| !s.is_empty())
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_deepseek_chan_voice() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../profiles/deepseek-chan/voice.toml"
        );
        let text = std::fs::read_to_string(path).unwrap();
        let table: toml::Table = toml::from_str(&text).unwrap();
        let p = VoiceProfile::parse("deepseek-chan", Some(&table)).unwrap();
        assert_eq!(p.provider.as_deref(), Some("qwen3-tts"));
        assert_eq!(p.voice, "deepseek-chan");
        assert!(p.cloned);
        assert_eq!(
            p.instruct_for(Some("Annoyed")).as_deref(),
            Some("不耐煩、拖長音")
        );
        assert_eq!(p.instruct_for(Some("neutral")), None);
        assert_eq!(p.instruct_for(None), None);
    }

    #[test]
    fn explicit_voice_and_empty_profile() {
        let table: toml::Table = toml::from_str("voice = \"miyoria-v2\"").unwrap();
        assert_eq!(
            VoiceProfile::parse("x", Some(&table)).unwrap().voice,
            "miyoria-v2"
        );
        let empty = VoiceProfile::parse("x", None).unwrap();
        assert_eq!(empty.voice, "x");
        assert!(empty.instruct.is_empty());
    }

    #[test]
    fn config_defaults() {
        let c: VoiceConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(c.consent, ConsentPolicy::OptOut);
        assert_eq!(c.barge_in, BargeInMode::Stop);
        assert_eq!(
            (c.end_silence_ms, c.max_utterance_ms, c.min_utterance_ms),
            (600, 15_000, 300)
        );
        let c: VoiceConfig =
            serde_json::from_value(serde_json::json!({"consent": "opt-in", "barge_in": "ignore"}))
                .unwrap();
        assert_eq!(c.consent, ConsentPolicy::OptIn);
        assert_eq!(c.barge_in, BargeInMode::Ignore);
    }
}
