//! Splits one speaker's audio stream into utterances.

use std::collections::VecDeque;

use crate::vad::Vad;

/// Utterance boundaries, in milliseconds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmenterConfig {
    pub sample_rate: u32,
    /// Low energy for this long ends an utterance.
    pub end_silence_ms: u32,
    /// Utterances are cut at this length.
    pub max_utterance_ms: u32,
    /// Shorter utterances (speech part, without trailing silence) are dropped.
    pub min_utterance_ms: u32,
    /// Utterances with less voiced audio than this are dropped.
    pub min_voiced_ms: u32,
    /// Audio kept from before speech onset.
    pub pre_roll_ms: u32,
    /// Trailing silence kept at the end of an utterance.
    pub tail_ms: u32,
    /// Consecutive speech frames needed to start an utterance.
    pub onset_frames: u32,
    /// Gaps up to this long do not reset [`Segmenter::speech_run_ms`].
    pub run_gap_ms: u32,
}

impl Default for SegmenterConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            end_silence_ms: 600,
            max_utterance_ms: 15_000,
            min_utterance_ms: 300,
            min_voiced_ms: 200,
            pre_roll_ms: 200,
            tail_ms: 200,
            onset_frames: 2,
            run_gap_ms: 250,
        }
    }
}

/// A finished utterance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Utterance {
    pub samples: Vec<i16>,
    /// Speech part, from onset (incl. pre-roll) to the last voiced frame.
    pub speech_ms: u32,
    /// Sum of voiced frames.
    pub voiced_ms: u32,
    /// Silence between the last voiced frame and the end-of-utterance
    /// decision (only part of it is kept in `samples`).
    pub trailing_silence_ms: u32,
}

/// Feed PCM with [`push`](Self::push); finished utterances come back as they
/// are detected. Call [`finish`](Self::finish) when the stream closes.
pub struct Segmenter<V: Vad> {
    vad: V,
    config: SegmenterConfig,
    frame_len: usize,
    frame_ms: u32,
    /// Leftover samples that do not fill a frame yet.
    partial: Vec<i16>,
    /// Recent non-speech frames, kept as pre-roll.
    pre_roll: VecDeque<Vec<i16>>,
    /// Speech frames in a row before onset.
    onset: Vec<Vec<i16>>,
    active: bool,
    buf: Vec<i16>,
    /// `buf` length at the last voiced frame.
    speech_end: usize,
    voiced_ms: u32,
    silence_ms: u32,
    run_ms: u32,
    gap_ms: u32,
}

impl<V: Vad> Segmenter<V> {
    pub fn new(vad: V, config: SegmenterConfig) -> Self {
        let frame_len = vad.frame_len().max(1);
        let frame_ms =
            u32::try_from(frame_len as u64 * 1000 / u64::from(config.sample_rate.max(1)))
                .unwrap_or(u32::MAX)
                .max(1);
        Self {
            vad,
            config,
            frame_len,
            frame_ms,
            partial: Vec::new(),
            pre_roll: VecDeque::new(),
            onset: Vec::new(),
            active: false,
            buf: Vec::new(),
            speech_end: 0,
            voiced_ms: 0,
            silence_ms: 0,
            run_ms: 0,
            gap_ms: 0,
        }
    }

    /// An utterance is in progress.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// How long the speaker has been talking continuously (short gaps
    /// tolerated). Used for barge-in.
    pub fn speech_run_ms(&self) -> u32 {
        self.run_ms
    }

    pub fn push(&mut self, samples: &[i16]) -> Vec<Utterance> {
        let mut out = Vec::new();
        self.partial.extend_from_slice(samples);
        let mut start = 0;
        while self.partial.len() - start >= self.frame_len {
            let frame = self.partial[start..start + self.frame_len].to_vec();
            start += self.frame_len;
            if let Some(u) = self.frame(frame) {
                out.push(u);
            }
        }
        self.partial.drain(..start);
        out
    }

    /// Ends the stream: returns the utterance in progress, if it qualifies.
    pub fn finish(&mut self) -> Option<Utterance> {
        let partial = std::mem::take(&mut self.partial);
        if self.active && !partial.is_empty() {
            self.buf.extend_from_slice(&partial);
        }
        let out = if self.active { self.emit() } else { None };
        self.reset();
        self.pre_roll.clear();
        out
    }

    fn frame(&mut self, frame: Vec<i16>) -> Option<Utterance> {
        let speech = self.vad.is_speech(&frame);
        self.track_run(speech);
        if !self.active {
            if speech {
                self.onset.push(frame);
                if self.onset.len() as u32 >= self.config.onset_frames.max(1) {
                    self.begin();
                }
            } else {
                // A lone blip is not an onset; keep it as pre-roll.
                for f in std::mem::take(&mut self.onset) {
                    self.remember(f);
                }
                self.remember(frame);
            }
            return None;
        }

        self.buf.extend_from_slice(&frame);
        if speech {
            self.voiced_ms += self.frame_ms;
            self.silence_ms = 0;
            self.speech_end = self.buf.len();
        } else {
            self.silence_ms += self.frame_ms;
        }
        let len_ms = self.ms(self.buf.len());
        if self.silence_ms >= self.config.end_silence_ms || len_ms >= self.config.max_utterance_ms {
            let out = self.emit();
            self.reset();
            return out;
        }
        None
    }

    fn track_run(&mut self, speech: bool) {
        if speech {
            self.run_ms += self.frame_ms + self.gap_ms;
            self.gap_ms = 0;
        } else if self.run_ms > 0 {
            self.gap_ms += self.frame_ms;
            if self.gap_ms > self.config.run_gap_ms {
                self.run_ms = 0;
                self.gap_ms = 0;
            }
        }
    }

    fn remember(&mut self, frame: Vec<i16>) {
        self.pre_roll.push_back(frame);
        let keep = (self.config.pre_roll_ms / self.frame_ms) as usize;
        while self.pre_roll.len() > keep {
            self.pre_roll.pop_front();
        }
    }

    fn begin(&mut self) {
        self.active = true;
        self.buf.clear();
        for f in self.pre_roll.drain(..) {
            self.buf.extend_from_slice(&f);
        }
        let onset = std::mem::take(&mut self.onset);
        self.voiced_ms = self.frame_ms * onset.len() as u32;
        for f in onset {
            self.buf.extend_from_slice(&f);
        }
        self.speech_end = self.buf.len();
        self.silence_ms = 0;
    }

    fn emit(&mut self) -> Option<Utterance> {
        let speech_ms = self.ms(self.speech_end);
        let trailing = self.ms(self.buf.len().saturating_sub(self.speech_end));
        if speech_ms < self.config.min_utterance_ms || self.voiced_ms < self.config.min_voiced_ms {
            return None;
        }
        let tail = self.samples(self.config.tail_ms);
        let end = (self.speech_end + tail).min(self.buf.len());
        let mut samples = std::mem::take(&mut self.buf);
        samples.truncate(end);
        Some(Utterance {
            samples,
            speech_ms,
            voiced_ms: self.voiced_ms,
            trailing_silence_ms: trailing,
        })
    }

    fn reset(&mut self) {
        self.active = false;
        self.buf.clear();
        self.onset.clear();
        self.speech_end = 0;
        self.voiced_ms = 0;
        self.silence_ms = 0;
    }

    fn ms(&self, samples: usize) -> u32 {
        u32::try_from(samples as u64 * 1000 / u64::from(self.config.sample_rate.max(1)))
            .unwrap_or(u32::MAX)
    }

    fn samples(&self, ms: u32) -> usize {
        (u64::from(ms) * u64::from(self.config.sample_rate) / 1000) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vad::EnergyVad;
    use crate::vad::synth::*;

    fn seg() -> Segmenter<EnergyVad> {
        Segmenter::new(EnergyVad::default(), SegmenterConfig::default())
    }

    fn feed(s: &mut Segmenter<EnergyVad>, audio: &[i16]) -> Vec<Utterance> {
        // 20 ms network frames, like the voice node sends.
        audio.chunks(320).flat_map(|c| s.push(c)).collect()
    }

    #[test]
    fn silence_produces_nothing() {
        let mut s = seg();
        assert!(feed(&mut s, &silence(3000)).is_empty());
        assert!(s.finish().is_none());
    }

    #[test]
    fn speech_then_silence_ends_an_utterance() {
        let mut s = seg();
        let mut audio = silence(500);
        audio.extend(voice(1200, 0.3));
        audio.extend(silence(1000));
        let out = feed(&mut s, &audio);
        assert_eq!(out.len(), 1);
        let u = &out[0];
        assert!((1200..=1500).contains(&u.speech_ms), "{}", u.speech_ms);
        assert!(u.voiced_ms >= 900, "{}", u.voiced_ms);
        assert!(u.trailing_silence_ms >= 600);
        // Pre-roll + speech + tail.
        let ms = u.samples.len() * 1000 / RATE;
        assert!((1300..=1800).contains(&ms), "{ms}");
        assert!(!s.is_active());
        assert!(s.finish().is_none());
    }

    #[test]
    fn short_pauses_do_not_split() {
        let mut s = seg();
        let mut audio = voice(800, 0.3);
        audio.extend(silence(300));
        audio.extend(voice(800, 0.3));
        audio.extend(silence(800));
        let out = feed(&mut s, &audio);
        assert_eq!(out.len(), 1, "{out:?}");
        assert!(out[0].speech_ms >= 1800);
    }

    #[test]
    fn two_utterances() {
        let mut s = seg();
        let mut audio = voice(700, 0.3);
        audio.extend(silence(900));
        audio.extend(tone(600, 220.0, 0.2));
        audio.extend(silence(900));
        assert_eq!(feed(&mut s, &audio).len(), 2);
    }

    #[test]
    fn short_bursts_are_dropped() {
        let mut s = seg();
        let mut audio = Vec::new();
        for _ in 0..5 {
            audio.extend(tone(100, 300.0, 0.3));
            audio.extend(silence(800));
        }
        assert!(feed(&mut s, &audio).is_empty());
        // A single loud click frame.
        let mut click = silence(200);
        click.extend(tone(20, 300.0, 0.9));
        click.extend(silence(1000));
        assert!(feed(&mut s, &click).is_empty());
    }

    #[test]
    fn noise_is_dropped() {
        let mut s = seg();
        assert!(feed(&mut s, &noise(5000, 0.03, 9)).is_empty());
        assert!(s.finish().is_none());
    }

    #[test]
    fn speech_in_background_noise() {
        let mut s = seg();
        let mut audio = noise(3000, 0.01, 10);
        audio.extend(mix(&voice(1500, 0.3), &noise(1500, 0.01, 11)));
        audio.extend(noise(1500, 0.01, 12));
        let out = feed(&mut s, &audio);
        assert_eq!(out.len(), 1, "{out:?}");
        assert!(out[0].speech_ms >= 1300, "{}", out[0].speech_ms);
    }

    #[test]
    fn long_speech_is_cut_at_max() {
        let mut s = Segmenter::new(
            EnergyVad::default(),
            SegmenterConfig {
                max_utterance_ms: 2000,
                ..SegmenterConfig::default()
            },
        );
        let out = feed(&mut s, &voice(5000, 0.3));
        assert!(out.len() >= 2, "{}", out.len());
        for u in &out {
            assert!(u.samples.len() * 1000 / RATE <= 2000);
        }
    }

    #[test]
    fn stream_close_flushes() {
        let mut s = seg();
        assert!(feed(&mut s, &voice(900, 0.3)).is_empty());
        assert!(s.is_active());
        let u = s.finish().expect("utterance on close");
        assert!(u.speech_ms >= 850);
        assert!(!s.is_active());
        // Too short to keep.
        feed(&mut s, &voice(150, 0.3));
        assert!(s.finish().is_none());
    }

    #[test]
    fn speech_run_tracks_continuous_talk() {
        let mut s = seg();
        feed(&mut s, &voice(700, 0.3));
        assert!(s.speech_run_ms() >= 600, "{}", s.speech_run_ms());
        feed(&mut s, &silence(400));
        assert_eq!(s.speech_run_ms(), 0);
    }
}
