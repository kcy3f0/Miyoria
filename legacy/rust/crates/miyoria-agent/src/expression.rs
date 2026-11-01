//! Streaming parser for the tagged reply format.
//!
//! ```text
//! <emo:happy>欸你回來啦!<pause 300/>今天的考試怎麼樣?
//! ```
//!
//! Recognised tags: `<emo:name>`, `<pause N/>` (milliseconds) and
//! `<silence/>`. Tags may be split across chunks; anything that does not form
//! a valid tag is passed through as text.

use std::time::Duration;

/// Longest tag the parser waits for before giving up and treating `<` as text.
const MAX_TAG_LEN: usize = 48;
const MAX_EMOTION_LEN: usize = 32;
const DEFAULT_PAUSE_MS: u64 = 300;
const MAX_PAUSE_MS: u64 = 10_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Segment {
    /// Clean text. Consecutive text segments belong together.
    Text(String),
    /// Lower-cased emotion name.
    Emotion(String),
    Pause(Duration),
    Silence,
}

/// Incremental parser: feed chunks with [`push`](Self::push), then call
/// [`finish`](Self::finish) once the stream ends.
#[derive(Debug, Default)]
pub struct ExpressionParser {
    /// Unconsumed input that may be the start of a tag.
    held: String,
}

impl ExpressionParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &str) -> Vec<Segment> {
        self.held.push_str(chunk);
        self.drain(false)
    }

    /// Flushes held input; an unterminated tag becomes text.
    pub fn finish(&mut self) -> Vec<Segment> {
        self.drain(true)
    }

    fn drain(&mut self, eof: bool) -> Vec<Segment> {
        let input = std::mem::take(&mut self.held);
        let mut out = Vec::new();
        let mut text = String::new();
        let mut pos = 0;
        while let Some(offset) = input[pos..].find('<') {
            let start = pos + offset;
            text.push_str(&input[pos..start]);
            match scan_tag(&input[start..]) {
                Scan::Tag(segment, len) => {
                    flush(&mut text, &mut out);
                    out.push(segment);
                    pos = start + len;
                }
                Scan::Partial if !eof => {
                    flush(&mut text, &mut out);
                    self.held = input[start..].to_owned();
                    return out;
                }
                Scan::Partial | Scan::NotATag => {
                    text.push('<');
                    pos = start + 1;
                }
            }
        }
        text.push_str(&input[pos..]);
        flush(&mut text, &mut out);
        out
    }
}

fn flush(text: &mut String, out: &mut Vec<Segment>) {
    if !text.is_empty() {
        out.push(Segment::Text(std::mem::take(text)));
    }
}

enum Scan {
    /// A complete tag of `len` bytes (including `<` and `>`).
    Tag(Segment, usize),
    /// Could still become a tag once more input arrives.
    Partial,
    NotATag,
}

/// `s` starts with `<`.
fn scan_tag(s: &str) -> Scan {
    match s.find('>') {
        Some(end) if end <= MAX_TAG_LEN => match parse_tag(&s[1..end]) {
            Some(segment) => Scan::Tag(segment, end + 1),
            None => Scan::NotATag,
        },
        Some(_) => Scan::NotATag,
        None if s.len() <= MAX_TAG_LEN && is_tag_prefix(&s[1..]) => Scan::Partial,
        None => Scan::NotATag,
    }
}

/// Parses the inside of `<...>`.
fn parse_tag(body: &str) -> Option<Segment> {
    let body = body.trim();
    let body = body.strip_suffix('/').unwrap_or(body).trim_end();
    let lower = body.to_ascii_lowercase();
    if let Some(name) = lower.strip_prefix("emo:") {
        let name = name.trim();
        let valid =
            !name.is_empty() && name.len() <= MAX_EMOTION_LEN && name.chars().all(is_name_char);
        return valid.then(|| Segment::Emotion(name.to_owned()));
    }
    if lower == "silence" {
        return Some(Segment::Silence);
    }
    if let Some(rest) = lower.strip_prefix("pause") {
        if rest.is_empty() {
            return Some(Segment::Pause(Duration::from_millis(DEFAULT_PAUSE_MS)));
        }
        if !rest.starts_with([' ', '=']) {
            return None;
        }
        let rest = rest.trim_start_matches([' ', '=']);
        let digits = rest.strip_suffix("ms").unwrap_or(rest).trim_end();
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let ms = digits
            .parse::<u64>()
            .unwrap_or(MAX_PAUSE_MS)
            .min(MAX_PAUSE_MS);
        return Some(Segment::Pause(Duration::from_millis(ms)));
    }
    None
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

type CharTest = fn(char) -> bool;

/// Whether `rest` (input after `<`, no `>` yet) can still grow into a tag.
fn is_tag_prefix(rest: &str) -> bool {
    let lower = rest.to_ascii_lowercase();
    let allowed: [(&str, CharTest); 3] = [
        ("emo:", |c| is_name_char(c) || c == ' ' || c == '/'),
        ("pause", |c| {
            c.is_ascii_digit() || matches!(c, ' ' | '=' | 'm' | 's' | '/')
        }),
        ("silence", |c| matches!(c, ' ' | '/')),
    ];
    allowed.iter().any(|(keyword, ok)| {
        keyword.starts_with(lower.as_str())
            || lower
                .strip_prefix(keyword)
                .is_some_and(|tail| tail.chars().all(ok))
    })
}

/// Everything a complete reply expressed, folded from segments.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Expression {
    pub text: String,
    pub emotions: Vec<String>,
    /// `<silence/>` came before any visible text: she chose not to reply.
    pub silence: bool,
}

impl Expression {
    pub fn parse(s: &str) -> Self {
        let mut parser = ExpressionParser::new();
        let mut out = Self::default();
        for segment in parser.push(s).into_iter().chain(parser.finish()) {
            out.apply(segment);
        }
        out
    }

    /// Folds one segment in. Once silent, the rest of the reply is ignored.
    pub fn apply(&mut self, segment: Segment) {
        if self.silence {
            return;
        }
        match segment {
            Segment::Text(t) => self.text.push_str(&t),
            Segment::Emotion(e) => self.emotions.push(e),
            Segment::Pause(_) => {}
            Segment::Silence => {
                if self.text.trim().is_empty() {
                    self.silence = true;
                }
            }
        }
    }

    /// Nothing should be sent.
    pub fn is_silent(&self) -> bool {
        self.silence || self.text.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emo(s: &str) -> Segment {
        Segment::Emotion(s.to_owned())
    }

    fn text(s: &str) -> Segment {
        Segment::Text(s.to_owned())
    }

    fn pause(ms: u64) -> Segment {
        Segment::Pause(Duration::from_millis(ms))
    }

    /// Parses `chunks` and merges adjacent text segments.
    fn parse_chunks(chunks: &[&str]) -> Vec<Segment> {
        let mut parser = ExpressionParser::new();
        let mut raw = Vec::new();
        for c in chunks {
            raw.extend(parser.push(c));
        }
        raw.extend(parser.finish());
        let mut out: Vec<Segment> = Vec::new();
        for seg in raw {
            match (out.last_mut(), seg) {
                (Some(Segment::Text(prev)), Segment::Text(t)) => prev.push_str(&t),
                (_, seg) => out.push(seg),
            }
        }
        out
    }

    #[test]
    fn parses_all_tag_kinds() {
        assert_eq!(
            parse_chunks(&["<emo:happy>欸你回來啦!<pause 300/>今天的考試怎麼樣?<emo:curious>"]),
            [
                emo("happy"),
                text("欸你回來啦!"),
                pause(300),
                text("今天的考試怎麼樣?"),
                emo("curious"),
            ]
        );
        assert_eq!(parse_chunks(&["<silence/>"]), [Segment::Silence]);
    }

    #[test]
    fn tags_split_across_chunks() {
        let expected = [emo("smug"), text("哼"), pause(500), text("。")];
        let whole = "<emo:smug>哼<pause 500/>。";
        assert_eq!(parse_chunks(&[whole]), expected);
        // Every possible split point, including inside multi-byte characters' neighbours.
        let bounds: Vec<usize> = whole.char_indices().map(|(i, _)| i).collect();
        for &i in &bounds {
            assert_eq!(
                parse_chunks(&[&whole[..i], &whole[i..]]),
                expected,
                "split at {i}"
            );
        }
        // One character per chunk.
        let chars: Vec<String> = whole.chars().map(String::from).collect();
        let chunks: Vec<&str> = chars.iter().map(String::as_str).collect();
        assert_eq!(parse_chunks(&chunks), expected);
    }

    #[test]
    fn streams_text_before_a_pending_tag() {
        let mut p = ExpressionParser::new();
        assert_eq!(p.push("你好<em"), [text("你好")]);
        assert_eq!(p.push("o:sad"), []);
        assert_eq!(p.push(">嗚"), [emo("sad"), text("嗚")]);
        assert_eq!(p.finish(), []);
    }

    #[test]
    fn malformed_tags_are_text() {
        assert_eq!(parse_chunks(&["a < b"]), [text("a < b")]);
        assert_eq!(parse_chunks(&["<3 你"]), [text("<3 你")]);
        assert_eq!(parse_chunks(&["<b>粗體</b>"]), [text("<b>粗體</b>")]);
        assert_eq!(parse_chunks(&["<emo:>x"]), [text("<emo:>x")]);
        assert_eq!(parse_chunks(&["<emo:開心>x"]), [text("<emo:開心>x")]);
        assert_eq!(parse_chunks(&["<pause abc/>"]), [text("<pause abc/>")]);
        assert_eq!(parse_chunks(&["<pauses/>"]), [text("<pauses/>")]);
        assert_eq!(
            parse_chunks(&["<silence please>"]),
            [text("<silence please>")]
        );
        // Unterminated tag at end of stream.
        assert_eq!(parse_chunks(&["好啦<emo:hap"]), [text("好啦<emo:hap")]);
        assert_eq!(parse_chunks(&["結尾<"]), [text("結尾<")]);
    }

    #[test]
    fn nested_angle_brackets_recover() {
        assert_eq!(
            parse_chunks(&["<<emo:happy>耶"]),
            [text("<"), emo("happy"), text("耶")]
        );
        assert_eq!(parse_chunks(&["<emo<emo:sad>"]), [text("<emo"), emo("sad")]);
    }

    #[test]
    fn overlong_tag_is_text() {
        let long = format!("<emo:{}>", "a".repeat(60));
        assert_eq!(parse_chunks(&[&long]), [text(&long)]);
        // Same when it arrives in pieces: the parser stops waiting.
        let (a, b) = long.split_at(55);
        assert_eq!(parse_chunks(&[a, b]), [text(&long)]);
    }

    #[test]
    fn lenient_tag_variants() {
        assert_eq!(parse_chunks(&["<EMO:Happy>"]), [emo("happy")]);
        assert_eq!(parse_chunks(&["<emo: angry >"]), [emo("angry")]);
        assert_eq!(parse_chunks(&["<emo:happy/>"]), [emo("happy")]);
        assert_eq!(parse_chunks(&["<pause 200>"]), [pause(200)]);
        assert_eq!(parse_chunks(&["<pause 200ms />"]), [pause(200)]);
        assert_eq!(parse_chunks(&["<pause=150/>"]), [pause(150)]);
        assert_eq!(parse_chunks(&["<pause/>"]), [pause(DEFAULT_PAUSE_MS)]);
        assert_eq!(parse_chunks(&["<pause 999999/>"]), [pause(MAX_PAUSE_MS)]);
        assert_eq!(parse_chunks(&["<silence />"]), [Segment::Silence]);
        assert_eq!(parse_chunks(&["<silence>"]), [Segment::Silence]);
        assert_eq!(parse_chunks(&["<SILENCE/>"]), [Segment::Silence]);
    }

    #[test]
    fn empty_and_plain_input() {
        assert_eq!(parse_chunks(&[]), []);
        assert_eq!(parse_chunks(&["", ""]), []);
        assert_eq!(parse_chunks(&["只是文字"]), [text("只是文字")]);
        assert_eq!(parse_chunks(&["a>b"]), [text("a>b")]);
    }

    #[test]
    fn expression_folding_and_silence() {
        let e = Expression::parse("<emo:annoyed>現在都中午了好嗎……<emo:neutral>早啦。");
        assert_eq!(e.text, "現在都中午了好嗎……早啦。");
        assert_eq!(e.emotions, ["annoyed", "neutral"]);
        assert!(!e.is_silent());

        let e = Expression::parse("  <silence/>");
        assert!(e.silence && e.is_silent());

        // Text after a leading silence is ignored.
        let e = Expression::parse("<emo:sad><silence/>其實我想說");
        assert!(e.is_silent());
        assert_eq!(e.text, "");

        // A silence tag after visible text is not a refusal.
        let e = Expression::parse("嗯<silence/>好");
        assert!(!e.silence);
        assert_eq!(e.text, "嗯好");

        assert!(Expression::parse("<emo:happy>  ").is_silent());
        assert!(Expression::parse("").is_silent());
    }
}
