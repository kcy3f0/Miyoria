//! Turns a raw s16le byte stream into [`AudioChunk`](crate::AudioChunk)s.

use bytes::Bytes;
use futures::{Stream, StreamExt, future};

use crate::{AudioBuf, AudioStream};

/// Re-frames an arbitrary byte chunk into whole samples.
///
/// Network chunks can split a 16-bit sample; the odd trailing byte is carried
/// into the next call. Returns `None` when no complete sample is available.
fn decode_chunk(carry: &mut Option<u8>, rate: u32, bytes: &[u8]) -> Option<AudioBuf> {
    let mut samples = Vec::with_capacity(bytes.len() / 2 + 1);
    let mut rest = bytes;
    if let Some(lo) = carry.take() {
        match rest.split_first() {
            Some((&hi, tail)) => {
                samples.push(i16::from_le_bytes([lo, hi]));
                rest = tail;
            }
            None => {
                *carry = Some(lo);
                return None;
            }
        }
    }
    let pairs = rest.chunks_exact(2);
    if let [odd] = pairs.remainder() {
        *carry = Some(*odd);
    }
    samples.extend(pairs.map(|p| i16::from_le_bytes([p[0], p[1]])));
    (!samples.is_empty()).then_some(AudioBuf {
        sample_rate: rate,
        samples,
    })
}

/// Maps a stream of raw s16le byte chunks (any split) to audio chunks at
/// `rate`. A trailing odd byte at the end of the stream is dropped.
pub(crate) fn pcm_stream<S, E>(bytes: S, rate: u32) -> AudioStream
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: Into<anyhow::Error>,
{
    let mut carry = None;
    bytes
        .filter_map(move |item| {
            future::ready(match item {
                Ok(b) => decode_chunk(&mut carry, rate, &b).map(Ok),
                Err(e) => Some(Err(e.into())),
            })
        })
        .boxed()
}

/// Reads `rate=<n>` from a `Content-Type` such as `audio/L16; rate=24000`.
pub(crate) fn rate_from_content_type(content_type: &str) -> Option<u32> {
    content_type.split(';').skip(1).find_map(|param| {
        let (k, v) = param.split_once('=')?;
        k.trim()
            .eq_ignore_ascii_case("rate")
            .then(|| v.trim().trim_matches('"').parse().ok())?
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_odd_bytes_across_chunks() {
        let mut carry = None;
        let a = decode_chunk(&mut carry, 8000, &[1, 0, 2]).unwrap();
        assert_eq!(a.samples, vec![1]);
        assert_eq!(carry, Some(2));
        // a one-byte chunk completes the sample and leaves nothing behind
        let b = decode_chunk(&mut carry, 8000, &[0]).unwrap();
        assert_eq!(b.samples, vec![2]);
        assert_eq!(carry, None);
        // a lone byte yields no audio but is kept
        assert!(decode_chunk(&mut carry, 8000, &[7]).is_none());
        assert!(decode_chunk(&mut carry, 8000, &[]).is_none());
        assert_eq!(carry, Some(7));
    }

    #[test]
    fn parses_rate_param() {
        assert_eq!(
            rate_from_content_type("audio/L16; rate=24000; channels=1"),
            Some(24000)
        );
        assert_eq!(
            rate_from_content_type("audio/L16;Rate=\"16000\""),
            Some(16000)
        );
        assert_eq!(rate_from_content_type("audio/L16"), None);
        assert_eq!(rate_from_content_type("audio/L16; rate=abc"), None);
    }
}
