//! Voice activity detection.
//!
//! [`EnergyVad`] is a small energy + zero-crossing detector with an adaptive
//! noise floor. The [`Vad`] trait leaves room for a model-based detector
//! (e.g. Silero via ONNX Runtime) later.

use std::collections::VecDeque;

/// Classifies fixed-size frames of 16-bit mono PCM as speech or not.
pub trait Vad: Send {
    /// Frame length in samples this detector expects.
    fn frame_len(&self) -> usize;
    /// Whether `frame` (exactly [`frame_len`](Self::frame_len) samples) contains speech.
    fn is_speech(&mut self, frame: &[i16]) -> bool;
}

/// Tuning of [`EnergyVad`].
#[derive(Clone, Debug)]
pub struct EnergyVadConfig {
    pub sample_rate: u32,
    pub frame_ms: u32,
    /// Frames quieter than this (dBFS) are never speech.
    pub min_speech_db: f32,
    /// Speech must be this much louder than the noise floor (dB).
    pub margin_db: f32,
    /// Frames with a zero-crossing rate above this are treated as broadband
    /// noise. Unvoiced sounds inside words are bridged by the segmenter.
    pub max_zcr: f32,
    /// Noise floor = minimum frame energy over this window (minimum statistics).
    pub floor_window_ms: u32,
    /// Floor assumed before the window has filled.
    pub initial_floor_db: f32,
}

impl Default for EnergyVadConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            frame_ms: 20,
            min_speech_db: -50.0,
            margin_db: 10.0,
            max_zcr: 0.35,
            floor_window_ms: 3_000,
            initial_floor_db: -60.0,
        }
    }
}

/// Number of sub-blocks the floor window is split into.
const FLOOR_BLOCKS: usize = 10;
const SILENCE_DB: f32 = -100.0;

/// Energy / zero-crossing VAD with a minimum-statistics noise floor: the floor
/// is the quietest frame of the last few seconds, so steady background noise
/// (fans, hum) stops counting as speech after one window.
pub struct EnergyVad {
    config: EnergyVadConfig,
    frame_len: usize,
    block_frames: usize,
    /// Minimum energy of each finished block, newest last.
    blocks: VecDeque<f32>,
    block_min: f32,
    block_count: usize,
}

impl Default for EnergyVad {
    fn default() -> Self {
        Self::new(EnergyVadConfig::default())
    }
}

impl EnergyVad {
    pub fn new(config: EnergyVadConfig) -> Self {
        let frame_len = (config.sample_rate as usize * config.frame_ms as usize / 1000).max(1);
        let window_frames = (config.floor_window_ms / config.frame_ms.max(1)).max(1) as usize;
        let block_frames = (window_frames / FLOOR_BLOCKS).max(1);
        Self {
            blocks: VecDeque::from(vec![config.initial_floor_db; FLOOR_BLOCKS]),
            config,
            frame_len,
            block_frames,
            block_min: f32::MAX,
            block_count: 0,
        }
    }

    /// Current noise floor estimate in dBFS.
    pub fn noise_floor_db(&self) -> f32 {
        self.blocks.iter().copied().fold(self.block_min, f32::min)
    }

    fn track_floor(&mut self, energy_db: f32) {
        self.block_min = self.block_min.min(energy_db);
        self.block_count += 1;
        if self.block_count >= self.block_frames {
            self.blocks.pop_front();
            self.blocks.push_back(self.block_min);
            self.block_min = f32::MAX;
            self.block_count = 0;
        }
    }
}

/// RMS level in dBFS (`-100` for digital silence).
pub fn energy_db(frame: &[i16]) -> f32 {
    if frame.is_empty() {
        return SILENCE_DB;
    }
    let sum: f64 = frame.iter().map(|&s| f64::from(s) * f64::from(s)).sum();
    let rms = (sum / frame.len() as f64).sqrt() / 32768.0;
    if rms <= 1e-5 {
        SILENCE_DB
    } else {
        (20.0 * rms.log10()) as f32
    }
}

/// Fraction of adjacent sample pairs that change sign.
pub fn zero_crossing_rate(frame: &[i16]) -> f32 {
    if frame.len() < 2 {
        return 0.0;
    }
    let crossings = frame
        .windows(2)
        .filter(|w| (w[0] >= 0) != (w[1] >= 0))
        .count();
    crossings as f32 / (frame.len() - 1) as f32
}

impl Vad for EnergyVad {
    fn frame_len(&self) -> usize {
        self.frame_len
    }

    fn is_speech(&mut self, frame: &[i16]) -> bool {
        let e = energy_db(frame);
        let floor = self.noise_floor_db();
        self.track_floor(e);
        if e < self.config.min_speech_db || e < floor + self.config.margin_db {
            return false;
        }
        zero_crossing_rate(frame) <= self.config.max_zcr
    }
}

#[cfg(test)]
pub(crate) mod synth {
    //! Deterministic test signals at 16 kHz.

    pub const RATE: usize = 16_000;

    pub fn silence(ms: usize) -> Vec<i16> {
        vec![0; RATE * ms / 1000]
    }

    /// A sine tone with amplitude `amp` (0..1).
    pub fn tone(ms: usize, hz: f32, amp: f32) -> Vec<i16> {
        (0..RATE * ms / 1000)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                ((2.0 * std::f32::consts::PI * hz * t).sin() * amp * 32767.0) as i16
            })
            .collect()
    }

    /// Speech-like signal: a 180 Hz tone with harmonics, amplitude-modulated
    /// at a syllable rate of 4 Hz.
    pub fn voice(ms: usize, amp: f32) -> Vec<i16> {
        (0..RATE * ms / 1000)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                let w = 2.0 * std::f32::consts::PI * 180.0 * t;
                let carrier = w.sin() * 0.6 + (2.0 * w).sin() * 0.3 + (3.0 * w).sin() * 0.1;
                let envelope = 0.55 + 0.45 * (2.0 * std::f32::consts::PI * 4.0 * t).sin();
                (carrier * envelope * amp * 32767.0) as i16
            })
            .collect()
    }

    /// Uniform white noise with amplitude `amp` (0..1), from a fixed seed.
    pub fn noise(ms: usize, amp: f32, seed: u64) -> Vec<i16> {
        let mut state = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        (0..RATE * ms / 1000)
            .map(|_| {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                let u = ((state >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0;
                (u * amp * 32767.0) as i16
            })
            .collect()
    }

    pub fn mix(a: &[i16], b: &[i16]) -> Vec<i16> {
        a.iter()
            .zip(b)
            .map(|(&x, &y)| x.saturating_add(y))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::synth::*;
    use super::*;

    fn speech_frames(vad: &mut EnergyVad, audio: &[i16]) -> usize {
        let n = vad.frame_len();
        audio.chunks_exact(n).filter(|f| vad.is_speech(f)).count()
    }

    #[test]
    fn levels() {
        assert_eq!(energy_db(&silence(20)), -100.0);
        let full = energy_db(&tone(20, 400.0, 1.0));
        assert!((full - -3.0).abs() < 0.5, "{full}");
        let zcr = zero_crossing_rate(&tone(100, 400.0, 0.5));
        assert!((zcr - 0.05).abs() < 0.01, "{zcr}");
        assert!(zero_crossing_rate(&noise(100, 0.3, 1)) > 0.4);
    }

    #[test]
    fn silence_and_quiet_audio_are_not_speech() {
        let mut vad = EnergyVad::default();
        assert_eq!(speech_frames(&mut vad, &silence(1000)), 0);
        // -66 dBFS hiss.
        assert_eq!(speech_frames(&mut vad, &noise(1000, 0.001, 2)), 0);
    }

    #[test]
    fn voice_is_speech() {
        let mut vad = EnergyVad::default();
        let frames = speech_frames(&mut vad, &voice(1000, 0.3));
        assert!(frames >= 45, "{frames} of 50 frames");
    }

    #[test]
    fn white_noise_is_rejected() {
        let mut vad = EnergyVad::default();
        // About -35 dBFS: louder than the floor, but broadband.
        assert_eq!(speech_frames(&mut vad, &noise(2000, 0.03, 3)), 0);
    }

    #[test]
    fn voice_over_noise_is_detected() {
        let mut vad = EnergyVad::default();
        speech_frames(&mut vad, &noise(4000, 0.01, 4));
        let mixed = mix(&voice(1000, 0.3), &noise(1000, 0.01, 5));
        let frames = speech_frames(&mut vad, &mixed);
        assert!(frames >= 40, "{frames} of 50 frames");
    }

    #[test]
    fn steady_hum_adapts_away() {
        let mut vad = EnergyVad::default();
        // A constant 100 Hz hum: speech-like at first, noise once the floor
        // window has seen it.
        let hum = tone(8000, 100.0, 0.05);
        let n = vad.frame_len();
        let late: Vec<bool> = hum
            .chunks_exact(n)
            .map(|f| vad.is_speech(f))
            .skip(200)
            .collect();
        assert!(late.iter().all(|s| !s), "hum still detected after 4 s");
        assert!(vad.noise_floor_db() > -40.0);
        // Real speech on top of the hum still counts.
        let frames = speech_frames(&mut vad, &mix(&voice(1000, 0.4), &tone(1000, 100.0, 0.05)));
        assert!(frames >= 20, "{frames} of 50 frames");
    }
}
