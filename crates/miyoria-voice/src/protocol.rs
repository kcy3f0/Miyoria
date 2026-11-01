//! Voice Link v1 wire format (`docs/protocols/voice-link.md`).

use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 1;

/// Close codes used by Core.
pub mod close {
    /// Malformed hello, unsupported version or no hello in time.
    pub const BAD_HELLO: u16 = 4400;
    /// Wrong token.
    pub const UNAUTHORIZED: u16 = 4401;
    /// A newer connection for the same self account replaced this one.
    pub const REPLACED: u16 = 4409;
    /// Dead peer (no traffic within the heartbeat timeout).
    pub const TIMEOUT: u16 = 4408;
    /// Core is shutting down.
    pub const GOING_AWAY: u16 = 1001;
}

/// Binary frame tag of captured audio (node → Core).
pub const TAG_CAPTURE: u8 = 0x01;
/// Binary frame tag of playback audio (Core → node).
pub const TAG_PLAYBACK: u8 = 0x02;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelfAccount {
    pub platform: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireParticipant {
    pub user_id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub is_self: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub deafened: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WirePlaybackState {
    Started,
    Finished,
    Interrupted,
    Failed,
}

/// Go Live state reported by the node.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireGoLiveState {
    Starting,
    Live,
    Stopped,
    Failed,
}

/// Text frames sent by the voice node.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NodeMessage {
    Hello {
        version: u32,
        token: String,
        #[serde(default)]
        node: String,
        self_account: SelfAccount,
    },
    Joined {
        guild: String,
        channel: String,
    },
    Left {
        guild: String,
        #[serde(default)]
        reason: Option<String>,
    },
    VoiceState {
        guild: String,
        channel: String,
        participants: Vec<WireParticipant>,
    },
    Speaking {
        guild: String,
        user_id: String,
        speaking: bool,
    },
    StreamOpen {
        stream: u32,
        guild: String,
        channel: String,
        user_id: String,
        #[serde(default)]
        display_name: String,
        sample_rate: u32,
    },
    StreamClose {
        stream: u32,
    },
    Playback {
        play: u32,
        state: WirePlaybackState,
        #[serde(default)]
        error: Option<String>,
    },
    Golive {
        guild: String,
        state: WireGoLiveState,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        reason: Option<String>,
    },
    Error {
        message: String,
    },
    Ping,
    Pong,
}

/// Text frames sent by Core.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CoreMessage {
    Welcome {
        session: String,
    },
    Join {
        guild: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        user_id: Option<String>,
    },
    Leave {
        guild: String,
    },
    PlayStart {
        play: u32,
        guild: String,
        sample_rate: u32,
    },
    PlayEnd {
        play: u32,
    },
    PlayStop {
        play: u32,
        fade_ms: u32,
    },
    /// Starts a Go Live stream of `source` (see `docs/protocols/voice-link.md`).
    GoliveStart {
        guild: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel: Option<String>,
        source: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        width: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        height: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fps: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bitrate_kbps: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        encoder: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        listen: Option<bool>,
    },
    GoliveStop {
        guild: String,
    },
    Ping,
    Pong,
}

impl CoreMessage {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("core messages serialize")
    }
}

/// `[tag][id: u32 LE][PCM s16le ...]`.
pub fn encode_audio(tag: u8, id: u32, samples: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + samples.len() * 2);
    out.push(tag);
    out.extend_from_slice(&id.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Parses a binary frame into `(tag, id, samples)`. A trailing odd byte is
/// ignored.
pub fn decode_audio(frame: &[u8]) -> Option<(u8, u32, Vec<i16>)> {
    if frame.len() < 5 {
        return None;
    }
    let tag = frame[0];
    let id = u32::from_le_bytes([frame[1], frame[2], frame[3], frame[4]]);
    let samples = frame[5..]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    Some((tag, id, samples))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_frames_round_trip() {
        let frame = encode_audio(TAG_PLAYBACK, 7, &[1, -2, i16::MAX, i16::MIN]);
        assert_eq!(frame[0], 0x02);
        assert_eq!(&frame[1..5], &[7, 0, 0, 0]);
        let (tag, id, samples) = decode_audio(&frame).unwrap();
        assert_eq!((tag, id), (TAG_PLAYBACK, 7));
        assert_eq!(samples, [1, -2, i16::MAX, i16::MIN]);
        assert!(decode_audio(&[1, 2, 3]).is_none());
    }

    #[test]
    fn messages_match_the_spec() {
        let hello: NodeMessage = serde_json::from_str(
            r#"{"type":"hello","version":1,"token":"t","node":"voice-node",
                "self_account":{"platform":"discord","id":"42"}}"#,
        )
        .unwrap();
        assert!(matches!(hello, NodeMessage::Hello { version: 1, .. }));
        let pb: NodeMessage =
            serde_json::from_str(r#"{"type":"playback","play":3,"state":"finished"}"#).unwrap();
        assert_eq!(
            pb,
            NodeMessage::Playback {
                play: 3,
                state: WirePlaybackState::Finished,
                error: None
            }
        );
        let join = CoreMessage::Join {
            guild: "g".into(),
            channel: None,
            user_id: Some("u".into()),
        };
        assert_eq!(
            join.to_json(),
            r#"{"type":"join","guild":"g","user_id":"u"}"#
        );
        assert_eq!(
            CoreMessage::PlayStop {
                play: 1,
                fade_ms: 80
            }
            .to_json(),
            r#"{"type":"play_stop","play":1,"fade_ms":80}"#
        );
    }

    #[test]
    fn golive_messages_match_the_spec() {
        let start = CoreMessage::GoliveStart {
            guild: "g".into(),
            channel: None,
            source: "srt://127.0.0.1:9999".into(),
            width: None,
            height: Some(1080),
            fps: Some(60),
            bitrate_kbps: None,
            encoder: Some("nvenc".into()),
            audio: None,
            listen: None,
        };
        assert_eq!(
            start.to_json(),
            r#"{"type":"golive_start","guild":"g","source":"srt://127.0.0.1:9999","height":1080,"fps":60,"encoder":"nvenc"}"#
        );
        assert_eq!(
            CoreMessage::GoliveStop { guild: "g".into() }.to_json(),
            r#"{"type":"golive_stop","guild":"g"}"#
        );
        let live: NodeMessage =
            serde_json::from_str(r#"{"type":"golive","guild":"g","state":"live"}"#).unwrap();
        assert_eq!(
            live,
            NodeMessage::Golive {
                guild: "g".into(),
                state: WireGoLiveState::Live,
                error: None,
                reason: None
            }
        );
        let failed: NodeMessage = serde_json::from_str(
            r#"{"type":"golive","guild":"g","state":"failed","error":"ffmpeg not found"}"#,
        )
        .unwrap();
        assert!(matches!(
            failed,
            NodeMessage::Golive {
                state: WireGoLiveState::Failed,
                error: Some(_),
                ..
            }
        ));
    }
}
