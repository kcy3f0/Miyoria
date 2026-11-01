//! Stage: her body on the streaming PC.
//!
//! * Module `stage.link` ([`StageLinkModule`], Core side) serves the Stage
//!   Link WebSocket (`docs/protocols/stage-link.md`), forwards emotions,
//!   subtitles and speaking state to the Stage node and provides
//!   `Arc<`[`StageLink`]`>` (scene, stream, hotkey, gaze, status). It
//!   registers `stream start | stop | scene <name> | status`.
//!
//!   ```toml
//!   [modules."stage.link"]
//!   bind = "127.0.0.1:7882"
//!   token = "${STAGE_LINK_TOKEN}"
//!   ```
//!
//! * [`run_stage`] (Stage side, `miyoria stage`) connects to Core and drives
//!   VTube Studio ([`vts`]: expressions, hotkeys, lip sync and idle motion by
//!   parameter injection), OBS ([`obs`]) and the overlay ([`overlay`]). The
//!   voice node streams playback levels to its lip-sync endpoint
//!   ([`lipsync`]).

pub mod avatar;
pub mod emotion;
pub mod link;
pub mod lipsync;
pub mod motion;
pub mod obs;
pub mod overlay;
pub mod protocol;
mod runtime;
pub mod vts;

pub use avatar::{AvatarAction, AvatarProfile, LipSyncMode};
pub use link::{StageLink, StageLinkConfig, StageLinkModule};
pub use protocol::{GazeTarget, StageStatus, StreamAction};
pub use runtime::{StageConfig, run_stage, run_stage_with};
