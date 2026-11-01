//! Cuts streamed reply text into sentences, so each one can be sent to TTS
//! as soon as it is complete.
//!
//! Sentences end at `。！？!?…~～` and line breaks (a run such as `……` or
//! `?!` stays together, as do closing quotes and brackets after it). A clause
//! that grew past [`LONG_CLAUSE_CHARS`] is also cut at the next comma.

/// Characters that end a sentence.
const SENTENCE_ENDS: &[char] = &['。', '！', '？', '!', '?', '…', '~', '～', '\n'];
/// Commas that end a clause once it is long.
const CLAUSE_BREAKS: &[char] = &['，', ','];
/// Kept with the sentence they follow.
const CLOSERS: &[char] = &['」', '』', '）', ')', '】', '"', '”', '’', '\''];

/// A clause this long (in characters) is cut at the next comma.
pub const LONG_CLAUSE_CHARS: usize = 40;

/// Incremental splitter: [`push`](Self::push) text as it streams in, then
/// [`flush`](Self::flush) whatever is left once the response ends.
#[derive(Debug, Default)]
pub struct SentenceSplitter {
    buf: String,
}

impl SentenceSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds text; returns the sentences it completed (trimmed, non-empty).
    pub fn push(&mut self, text: &str) -> Vec<String> {
        self.buf.push_str(text);
        let mut out = Vec::new();
        while let Some(end) = self.cut() {
            let sentence: String = self.buf.drain(..end).collect();
            push_trimmed(&mut out, &sentence);
        }
        out
    }

    /// Takes the held text if it is a finished sentence (it ends with an end
    /// mark that was waiting for more input), e.g. before a new emotion
    /// starts.
    pub fn flush_complete(&mut self) -> Option<String> {
        let last = self.buf.trim_end().chars().next_back()?;
        if SENTENCE_ENDS.contains(&last) || CLOSERS.contains(&last) {
            self.flush()
        } else {
            None
        }
    }

    /// Takes the unfinished rest as a sentence, if there is any text.
    pub fn flush(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buf);
        let rest = rest.trim();
        (!rest.is_empty()).then(|| rest.to_owned())
    }

    /// Byte index just past the first complete sentence in the buffer. A
    /// sentence end at the very end of the buffer is not complete yet: more
    /// end marks (`…` after `…`) may follow in the next chunk.
    fn cut(&self) -> Option<usize> {
        let leading = self.buf.len() - self.buf.trim_start().len();
        let body = &self.buf[leading..];
        for (n, (i, c)) in body.char_indices().enumerate() {
            let ends = SENTENCE_ENDS.contains(&c)
                || (n >= LONG_CLAUSE_CHARS && CLAUSE_BREAKS.contains(&c));
            if !ends {
                continue;
            }
            let mut end = i + c.len_utf8();
            for next in body[end..].chars() {
                if SENTENCE_ENDS.contains(&next) || CLOSERS.contains(&next) {
                    end += next.len_utf8();
                } else {
                    break;
                }
            }
            return (end < body.len()).then_some(leading + end);
        }
        None
    }
}

fn push_trimmed(out: &mut Vec<String>, sentence: &str) {
    let sentence = sentence.trim();
    if !sentence.is_empty() {
        out.push(sentence.to_owned());
    }
}

/// Whether `text` has anything a TTS engine can say (letters or digits in
/// any script, not just punctuation or symbols).
pub fn is_speakable(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(chunks: &[&str]) -> Vec<String> {
        let mut s = SentenceSplitter::new();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(s.push(c));
        }
        out.extend(s.flush());
        out
    }

    #[test]
    fn splits_at_sentence_ends() {
        assert_eq!(
            split(&["哼,才不是在等你呢。你回來了喔?好啦!"]),
            ["哼,才不是在等你呢。", "你回來了喔?", "好啦!"]
        );
        assert_eq!(split(&["wait! what?ok"]), ["wait!", "what?", "ok"]);
        assert_eq!(split(&["第一行\n第二行"]), ["第一行", "第二行"]);
        assert_eq!(split(&["哼~才怪"]), ["哼~", "才怪"]);
        assert!(split(&["  \n "]).is_empty());
    }

    #[test]
    fn keeps_end_runs_and_closers_together() {
        assert_eq!(
            split(&["現在都中午了好嗎……早啦。"]),
            ["現在都中午了好嗎……", "早啦。"]
        );
        assert_eq!(split(&["真的?!", "假的"]), ["真的?!", "假的"]);
        assert_eq!(split(&["她說「好。」然後"]), ["她說「好。」", "然後"]);
        // The run continues in the next chunk.
        assert_eq!(split(&["好嗎…", "…早啦"]), ["好嗎……", "早啦"]);
    }

    #[test]
    fn streams_sentences_as_they_complete() {
        let mut s = SentenceSplitter::new();
        assert!(s.push("你好").is_empty());
        assert!(s.push("啊。").is_empty(), "end at buffer end waits");
        assert_eq!(s.push("今天"), ["你好啊。"]);
        assert_eq!(s.push("呢?明"), ["今天呢?"]);
        assert_eq!(s.flush().as_deref(), Some("明"));
        assert_eq!(s.flush(), None);

        assert!(s.push("一半").is_empty());
        assert_eq!(s.flush_complete(), None);
        assert!(s.push("。").is_empty());
        assert_eq!(s.flush_complete().as_deref(), Some("一半。"));
        assert_eq!(s.flush_complete(), None);
    }

    #[test]
    fn long_clauses_are_cut_at_commas() {
        let short = "短短的,還不用切";
        assert_eq!(split(&[short]), [short]);
        let head = "啊".repeat(LONG_CLAUSE_CHARS);
        let text = format!("{head},後面還有,再一句");
        assert_eq!(
            split(&[&text]),
            [format!("{head},"), "後面還有,再一句".to_owned()]
        );
        let ascii = format!("{}, and more", "a".repeat(LONG_CLAUSE_CHARS + 2));
        assert_eq!(split(&[&ascii]).len(), 2);
    }

    #[test]
    fn speakable_text() {
        assert!(is_speakable("哼。"));
        assert!(is_speakable("ok"));
        assert!(is_speakable("3"));
        assert!(!is_speakable("……!"));
        assert!(!is_speakable("🐋✨"));
    }
}
