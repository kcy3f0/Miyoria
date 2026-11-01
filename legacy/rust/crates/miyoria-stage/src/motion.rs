//! Idle head and eye motion: gentle noise around a pose that follows the
//! gaze target.

use std::time::Duration;

use serde::Deserialize;

use crate::protocol::GazeTarget;

/// Head angles (degrees, VTS range -30..30) and eye direction (-1..1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct GazePose {
    pub face_x: f32,
    pub face_y: f32,
    pub face_z: f32,
    pub eye_x: f32,
    pub eye_y: f32,
}

/// `[gaze]` section of the Stage config: one pose per target.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct GazeConfig {
    pub chat: GazePose,
    pub game: GazePose,
    pub camera: GazePose,
    /// Scale of the idle noise; 0 disables it. Default 1.0.
    pub idle_amount: f32,
    /// Time constant for turning towards a new target. Default 600.
    pub turn_ms: f32,
}

impl Default for GazeConfig {
    fn default() -> Self {
        Self {
            chat: GazePose {
                face_x: -12.0,
                face_y: -6.0,
                face_z: 2.0,
                eye_x: -0.6,
                eye_y: -0.3,
            },
            game: GazePose {
                face_x: 8.0,
                face_y: -10.0,
                face_z: 0.0,
                eye_x: 0.3,
                eye_y: -0.5,
            },
            camera: GazePose::default(),
            idle_amount: 1.0,
            turn_ms: 600.0,
        }
    }
}

impl GazeConfig {
    pub fn pose(&self, target: GazeTarget) -> GazePose {
        match target {
            GazeTarget::Chat => self.chat,
            GazeTarget::Game => self.game,
            GazeTarget::Camera => self.camera,
        }
    }
}

/// VTS input parameters driven by [`IdleMotion`].
pub const MOTION_PARAMS: [&str; 7] = [
    "FaceAngleX",
    "FaceAngleY",
    "FaceAngleZ",
    "EyeLeftX",
    "EyeLeftY",
    "EyeRightX",
    "EyeRightY",
];

pub struct IdleMotion {
    config: GazeConfig,
    target: GazeTarget,
    pose: GazePose,
    t: f32,
}

impl IdleMotion {
    pub fn new(config: GazeConfig) -> Self {
        let pose = config.camera;
        Self {
            config,
            target: GazeTarget::Camera,
            pose,
            t: 0.0,
        }
    }

    pub fn target(&self) -> GazeTarget {
        self.target
    }

    pub fn set_target(&mut self, target: GazeTarget) {
        self.target = target;
    }

    /// Advances by `dt`; returns values for [`MOTION_PARAMS`], in order.
    pub fn update(&mut self, dt: Duration) -> [f32; 7] {
        let dt = dt.as_secs_f32();
        self.t += dt;
        let goal = self.config.pose(self.target);
        let a = 1.0 - (-dt / (self.config.turn_ms.max(1.0) / 1000.0)).exp();
        let p = &mut self.pose;
        p.face_x += (goal.face_x - p.face_x) * a;
        p.face_y += (goal.face_y - p.face_y) * a;
        p.face_z += (goal.face_z - p.face_z) * a;
        p.eye_x += (goal.eye_x - p.eye_x) * a;
        p.eye_y += (goal.eye_y - p.eye_y) * a;

        // Sums of slow sines with unrelated periods look like drifting.
        let t = self.t;
        let k = self.config.idle_amount.max(0.0);
        let nx = 3.0 * (0.31 * t).sin() + 1.5 * (0.73 * t + 1.0).sin();
        let ny = 2.0 * (0.23 * t + 2.0).sin() + 1.0 * (0.61 * t).sin();
        let nz = 2.0 * (0.17 * t + 0.5).sin() + 0.7 * (0.47 * t + 3.0).sin();
        let ex = 0.08 * (0.9 * t + 0.3).sin() + 0.04 * (2.3 * t).sin();
        let ey = 0.05 * (0.7 * t + 1.2).sin();

        let face_x = (p.face_x + k * nx).clamp(-30.0, 30.0);
        let face_y = (p.face_y + k * ny).clamp(-30.0, 30.0);
        let face_z = (p.face_z + k * nz).clamp(-30.0, 30.0);
        let eye_x = (p.eye_x + k * ex).clamp(-1.0, 1.0);
        let eye_y = (p.eye_y + k * ey).clamp(-1.0, 1.0);
        [face_x, face_y, face_z, eye_x, eye_y, eye_x, eye_y]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = Duration::from_micros(16_667);

    #[test]
    fn turns_towards_the_target_and_stays_gentle() {
        let mut m = IdleMotion::new(GazeConfig::default());
        let mut max_dx: f32 = 0.0;
        let mut prev = m.update(TICK);
        for _ in 0..600 {
            let v = m.update(TICK);
            assert!(v[0].abs() <= 30.0 && v[3].abs() <= 1.0);
            max_dx = max_dx.max((v[0] - prev[0]).abs());
            prev = v;
        }
        assert!(max_dx < 0.5, "smooth: {max_dx}");
        assert!(prev[0].abs() < 5.0, "near the camera pose: {}", prev[0]);

        m.set_target(GazeTarget::Chat);
        for _ in 0..240 {
            prev = m.update(TICK);
        }
        // Within the noise of the chat pose.
        assert!((prev[0] - -12.0).abs() < 5.0, "{}", prev[0]);
        assert!((prev[3] - -0.6).abs() < 0.2, "{}", prev[3]);
        assert_eq!(prev[3], prev[5]);

        let mut still = IdleMotion::new(GazeConfig {
            idle_amount: 0.0,
            ..GazeConfig::default()
        });
        assert_eq!(still.update(TICK), [0.0; 7]);
    }
}
