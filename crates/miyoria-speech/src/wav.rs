//! Minimal WAV (RIFF) codec and a linear resampler for mono 16-bit audio.

use anyhow::{Context, bail};

use crate::AudioBuf;

const HEADER_LEN: usize = 44;

/// Encodes as a canonical 44-byte-header PCM WAV (mono, 16-bit).
pub fn encode(audio: &AudioBuf) -> Vec<u8> {
    let data_len = (audio.samples.len() * 2) as u32;
    let rate = audio.sample_rate;
    let mut out = Vec::with_capacity(HEADER_LEN + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in &audio.samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Decodes 16-bit PCM WAV, averaging multiple channels down to mono.
///
/// Unknown chunks are skipped. A `data` chunk whose declared size overruns the
/// buffer (streamed WAVs use 0 or `0xFFFFFFFF`) is clamped to the bytes present.
pub fn decode(bytes: &[u8]) -> anyhow::Result<AudioBuf> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        bail!("not a RIFF/WAVE file");
    }
    let mut pos = 12;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // tag, channels, rate, bits
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into()?) as usize;
        let body = pos + 8;
        if id == b"fmt " {
            let b = bytes.get(body..body + 16).context("truncated fmt chunk")?;
            fmt = Some((
                u16::from_le_bytes([b[0], b[1]]),
                u16::from_le_bytes([b[2], b[3]]),
                u32::from_le_bytes([b[4], b[5], b[6], b[7]]),
                u16::from_le_bytes([b[14], b[15]]),
            ));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = fmt.context("`data` chunk before `fmt `")?;
            // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (assumed PCM).
            if (tag != 1 && tag != 0xFFFE) || bits != 16 {
                bail!("unsupported WAV format (tag {tag}, {bits} bits); need 16-bit PCM");
            }
            if channels == 0 {
                bail!("WAV has zero channels");
            }
            let end = if size == 0 || size == u32::MAX as usize {
                bytes.len()
            } else {
                (body + size).min(bytes.len())
            };
            let channels = usize::from(channels);
            let samples = bytes[body..end]
                .chunks_exact(channels * 2)
                .map(|frame| {
                    let sum: i32 = frame
                        .chunks_exact(2)
                        .map(|s| i32::from(i16::from_le_bytes([s[0], s[1]])))
                        .sum();
                    (sum / channels as i32) as i16
                })
                .collect();
            return Ok(AudioBuf {
                sample_rate: rate,
                samples,
            });
        }
        pos = body + size + (size & 1); // chunks are word-aligned
    }
    bail!("WAV has no `data` chunk")
}

/// Resamples by linear interpolation.
///
/// Output length is `round(len * target / source)` and output `i` samples the
/// input at `i * source / target`, so the first sample is preserved and the
/// tail holds the last input sample. There is no low-pass filter: downsampling
/// by a large ratio aliases. That is fine for speech (e.g. 24 kHz to 16 kHz);
/// resample whole buffers, not chunk by chunk, to avoid seams.
pub fn resample(audio: &AudioBuf, target_rate: u32) -> AudioBuf {
    if audio.sample_rate == target_rate || audio.sample_rate == 0 || audio.samples.is_empty() {
        let sample_rate = if audio.sample_rate == 0 {
            0
        } else {
            target_rate
        };
        return AudioBuf {
            sample_rate,
            samples: audio.samples.clone(),
        };
    }
    let src = &audio.samples;
    let ratio = f64::from(audio.sample_rate) / f64::from(target_rate);
    let out_len = (src.len() as f64 / ratio).round() as usize;
    let last = src.len() - 1;
    let samples = (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let idx = pos as usize;
            if idx >= last {
                return src[last];
            }
            let frac = pos - idx as f64;
            let a = f64::from(src[idx]);
            let b = f64::from(src[idx + 1]);
            (a + (b - a) * frac).round() as i16
        })
        .collect();
    AudioBuf {
        sample_rate: target_rate,
        samples,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buf(rate: u32, samples: Vec<i16>) -> AudioBuf {
        AudioBuf {
            sample_rate: rate,
            samples,
        }
    }

    #[test]
    fn round_trip() {
        let a = buf(16_000, vec![0, 1, -1, i16::MAX, i16::MIN, 1234]);
        let bytes = encode(&a);
        assert_eq!(bytes.len(), 44 + 12);
        assert_eq!(decode(&bytes).unwrap(), a);
    }

    #[test]
    fn empty_round_trip() {
        let a = buf(8000, vec![]);
        assert_eq!(decode(&encode(&a)).unwrap(), a);
    }

    #[test]
    fn decode_downmixes_stereo_and_skips_unknown_chunks() {
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF\0\0\0\0WAVE");
        w.extend_from_slice(b"fmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        for v in [1u16, 2] {
            w.extend_from_slice(&v.to_le_bytes());
        }
        w.extend_from_slice(&44_100u32.to_le_bytes());
        w.extend_from_slice(&(44_100u32 * 4).to_le_bytes());
        w.extend_from_slice(&4u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"LIST");
        w.extend_from_slice(&3u32.to_le_bytes());
        w.extend_from_slice(&[1, 2, 3, 0]); // 3 bytes + pad
        w.extend_from_slice(b"data");
        w.extend_from_slice(&u32::MAX.to_le_bytes()); // streamed: unknown size
        for s in [100i16, 300, -50, 50] {
            w.extend_from_slice(&s.to_le_bytes());
        }
        let a = decode(&w).unwrap();
        assert_eq!(a, buf(44_100, vec![200, 0]));
    }

    #[test]
    fn decode_rejects_garbage_and_non_16_bit() {
        assert!(decode(b"nope").is_err());
        let mut w = encode(&buf(16_000, vec![1, 2]));
        w[34] = 8; // bits per sample
        assert!(decode(&w).is_err());
    }

    #[test]
    fn resample_length_and_endpoints() {
        let ramp: Vec<i16> = (0..160).map(|i| i * 100).collect();
        let a = buf(16_000, ramp);
        let up = resample(&a, 48_000);
        assert_eq!(up.sample_rate, 48_000);
        assert_eq!(up.samples.len(), 480);
        assert_eq!(up.samples[0], 0);
        assert_eq!(up.samples[3], 100); // exactly on input sample 1
        assert_eq!(up.samples[1], 33); // 1/3 of the way to 100
        assert_eq!(*up.samples.last().unwrap(), 15_900);

        let down = resample(&up, 16_000);
        assert_eq!(down.samples.len(), 160);
        assert_eq!(down.samples[0], 0);
        assert_eq!(down.samples[10], 1000);
    }

    #[test]
    fn resample_edge_cases() {
        let a = buf(16_000, vec![5, 6, 7]);
        assert_eq!(resample(&a, 16_000), a);
        assert!(resample(&buf(16_000, vec![]), 24_000).samples.is_empty());
        assert_eq!(resample(&buf(16_000, vec![9]), 32_000).samples, vec![9, 9]);
    }
}
