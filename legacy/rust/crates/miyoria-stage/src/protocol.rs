//! Stage Link v1 wire format (`docs/protocols/stage-link.md`).

use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 1;

/// Close codes used by Core.
pub mod close {
    /// Malformed hello, unsupported version or no hello in time.
    pub const BAD_HELLO: u16 = 4400;
    /// Wrong token.
    pub const UNAUTHORIZED: u16 = 4401;
    /// Dead peer (no traffic within the heartbeat timeout).
    pub const TIMEOUT: u16 = 4408;
    /// A newer Stage connection replaced this one.
    pub const REPLACED: u16 = 4409;
    /// Core is shutting down.
    pub const GOING_AWAY: u16 = 1001;
}

/// `stream` actions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamAction {
    Start,
    Stop,
}

/// Where she looks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GazeTarget {
    Chat,
    Game,
    #[default]
    Camera,
}

impl GazeTarget {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "chat" => Some(Self::Chat),
            "game" => Some(Self::Game),
            "camera" => Some(Self::Camera),
            _ => None,
        }
    }
}

/// `speaking` states.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeakingState {
    Started,
    Stopped,
}

/// What the Stage node reports in `status`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct StageStatus {
    /// Connected and authenticated to VTube Studio.
    pub vts: bool,
    /// Connected to OBS.
    pub obs: bool,
    /// Current OBS program scene.
    pub scene: Option<String>,
    /// OBS is streaming.
    pub streaming: bool,
}

/// Text frames sent by the Stage node.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StageMessage {
    Hello {
        version: u32,
        token: String,
        #[serde(default)]
        node: String,
        #[serde(default)]
        capabilities: Vec<String>,
    },
    /// Current state; `id` answers a Core request that succeeded.
    Status {
        #[serde(flatten)]
        status: StageStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
    },
    /// A failure; `id` answers a Core request that failed.
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
    },
    Ping,
    Pong,
}

impl StageMessage {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("stage messages serialize")
    }
}

/// Text frames sent by Core.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CoreMessage {
    Welcome {
        session: String,
    },
    Emotion {
        name: String,
        intensity: f32,
    },
    Subtitle {
        turn: String,
        text: String,
        #[serde(rename = "final")]
        is_final: bool,
    },
    Speaking {
        state: SpeakingState,
    },
    Scene {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
    },
    Stream {
        action: StreamAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
    },
    AvatarHotkey {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
    },
    Gaze {
        target: GazeTarget,
    },
    /// Asks for a `status` (with the same `id`).
    StatusRequest {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
    },
    Ping,
    Pong,
}

impl CoreMessage {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("core messages serialize")
    }
}

/// One playback level sample, sent by the voice node to the Stage lip-sync
/// endpoint (`ws://127.0.0.1:7883/levels`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LevelFrame {
    /// Playback position in milliseconds.
    #[serde(default)]
    pub t: f64,
    /// RMS of the audio being played, 0..1.
    pub rms: f32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn core_messages_match_the_spec() {
        let cases = [
            (
                CoreMessage::Emotion {
                    name: "happy".into(),
                    intensity: 1.0,
                },
                json!({"type": "emotion", "name": "happy", "intensity": 1.0}),
            ),
            (
                CoreMessage::Subtitle {
                    turn: "t1".into(),
                    text: "早安".into(),
                    is_final: true,
                },
                json!({"type": "subtitle", "turn": "t1", "text": "早安", "final": true}),
            ),
            (
                CoreMessage::Speaking {
                    state: SpeakingState::Started,
                },
                json!({"type": "speaking", "state": "started"}),
            ),
            (
                CoreMessage::Scene {
                    name: "Game".into(),
                    id: Some(3),
                },
                json!({"type": "scene", "name": "Game", "id": 3}),
            ),
            (
                CoreMessage::Stream {
                    action: StreamAction::Stop,
                    id: None,
                },
                json!({"type": "stream", "action": "stop"}),
            ),
            (
                CoreMessage::AvatarHotkey {
                    name: "Wave".into(),
                    id: None,
                },
                json!({"type": "avatar_hotkey", "name": "Wave"}),
            ),
            (
                CoreMessage::Gaze {
                    target: GazeTarget::Chat,
                },
                json!({"type": "gaze", "target": "chat"}),
            ),
        ];
        for (msg, expected) in cases {
            let value: serde_json::Value = serde_json::from_str(&msg.to_json()).unwrap();
            assert_eq!(value, expected);
            assert_eq!(
                serde_json::from_value::<CoreMessage>(expected).unwrap(),
                msg
            );
        }
    }

    #[test]
    fn stage_status_is_flat() {
        let msg = StageMessage::Status {
            status: StageStatus {
                vts: true,
                obs: false,
                scene: Some("Talk".into()),
                streaming: false,
            },
            id: Some(7),
        };
        let value: serde_json::Value = serde_json::from_str(&msg.to_json()).unwrap();
        assert_eq!(
            value,
            json!({"type": "status", "vts": true, "obs": false, "scene": "Talk", "streaming": false, "id": 7})
        );
        let parsed: StageMessage =
            serde_json::from_value(json!({"type": "status", "vts": false, "obs": true})).unwrap();
        assert_eq!(
            parsed,
            StageMessage::Status {
                status: StageStatus {
                    obs: true,
                    ..StageStatus::default()
                },
                id: None
            }
        );
    }

    #[test]
    fn level_frames() {
        let f: LevelFrame = serde_json::from_str(r#"{"t": 120, "rms": 0.25}"#).unwrap();
        assert_eq!(f.t, 120.0);
        assert_eq!(f.rms, 0.25);
    }
}
