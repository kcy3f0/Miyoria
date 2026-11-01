//! Splitting long text into Discord-sized messages.

/// Discord's message length limit.
pub const MAX_MESSAGE_LEN: usize = 2000;

/// Sentence and clause punctuation after which CJK text may be broken.
const CJK_BREAKS: &[char] = &[
    '。', '！', '？', '，', '、', '；', '：', '」', '』', '）', '…',
];

/// Splits `text` into chunks of at most `limit` UTF-16 code units (which is
/// never more than Discord's character count, even for emoji).
///
/// Breaks preferably at a newline, then at whitespace, then after CJK
/// punctuation, and only cuts mid-word when nothing else is found in the
/// second half of a chunk. Never splits inside a character. The break
/// character itself is dropped; whitespace-only chunks are skipped.
pub fn split_message(text: &str, limit: usize) -> Vec<String> {
    let limit = limit.max(2);
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let cut = fitting_prefix(rest, limit);
        if cut == rest.len() {
            push_chunk(&mut out, rest);
            break;
        }
        let head = &rest[..cut];
        let (end, next) = break_point(head).unwrap_or((cut, cut));
        push_chunk(&mut out, &rest[..end]);
        rest = &rest[next..];
    }
    out
}

/// Byte length of the longest prefix that fits in `limit` UTF-16 units.
fn fitting_prefix(s: &str, limit: usize) -> usize {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > limit {
            // Always make progress, even if a single char does not fit.
            return if i == 0 { c.len_utf8() } else { i };
        }
    }
    s.len()
}

/// `(chunk end, next chunk start)` within `head`, searched in its second half.
fn break_point(head: &str) -> Option<(usize, usize)> {
    let min = head.len() / 2;
    let rev = || head.char_indices().rev().take_while(|(i, _)| *i >= min);
    rev()
        .find(|(_, c)| *c == '\n')
        .or_else(|| rev().find(|(_, c)| c.is_whitespace()))
        .map(|(i, c)| (i, i + c.len_utf8()))
        .or_else(|| {
            rev()
                .find(|(_, c)| CJK_BREAKS.contains(c))
                .map(|(i, c)| (i + c.len_utf8(), i + c.len_utf8()))
        })
}

fn push_chunk(out: &mut Vec<String>, chunk: &str) {
    let chunk = chunk.trim_end();
    if !chunk.trim_start().is_empty() {
        out.push(chunk.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> usize {
        s.encode_utf16().count()
    }

    #[test]
    fn short_text_is_one_chunk() {
        assert_eq!(split_message("hello", 2000), ["hello"]);
        assert!(split_message("  \n ", 2000).is_empty());
    }

    #[test]
    fn prefers_newlines_then_spaces() {
        assert_eq!(
            split_message("aaaa bbbb\ncccc dddd", 12),
            ["aaaa bbbb", "cccc dddd"]
        );
        assert_eq!(split_message("aaaa bbbb cccc", 10), ["aaaa bbbb", "cccc"]);
    }

    #[test]
    fn cjk_without_spaces_breaks_after_punctuation() {
        let sentence = "今天天氣很好,我們去散步吧。";
        let text = sentence.repeat(300);
        let chunks = split_message(&text, MAX_MESSAGE_LEN);
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(units(c) <= MAX_MESSAGE_LEN);
            assert!(c.ends_with('。'), "{c}");
        }
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn hard_cuts_respect_char_boundaries() {
        let text = "喵".repeat(4500);
        let chunks = split_message(&text, MAX_MESSAGE_LEN);
        assert_eq!(
            chunks.iter().map(|c| c.chars().count()).collect::<Vec<_>>(),
            [2000, 2000, 500]
        );
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn emoji_count_as_two_units() {
        let text = "😀".repeat(1500);
        let chunks = split_message(&text, MAX_MESSAGE_LEN);
        assert_eq!(chunks[0].chars().count(), 1000);
        assert_eq!(chunks.concat(), text);
        // Tiny limits still fit one character per chunk.
        assert_eq!(split_message("😀😀", 1), ["😀", "😀"]);
    }
}
