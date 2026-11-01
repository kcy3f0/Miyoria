//! Search tokens for Chinese, Japanese and Latin text.
//!
//! Han runs are converted to simplified characters and segmented with jieba
//! (search mode), kana and Latin runs are
//! split at script boundaries and non-word characters. Everything is
//! lowercased, full-width ASCII is folded and stop words are dropped. The
//! same function is used for stored `tokens` and for queries.

use std::collections::HashSet;
use std::sync::LazyLock;

use jieba_rs::Jieba;

static JIEBA: LazyLock<Jieba> = LazyLock::new(Jieba::new);

static STOP_WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        // Chinese (traditional and simplified)
        "的",
        "了",
        "是",
        "在",
        "我",
        "你",
        "妳",
        "他",
        "她",
        "它",
        "牠",
        "我們",
        "你們",
        "他們",
        "她們",
        "我们",
        "你们",
        "他们",
        "和",
        "與",
        "与",
        "也",
        "就",
        "都",
        "而",
        "及",
        "著",
        "着",
        "啊",
        "吧",
        "呢",
        "嗎",
        "吗",
        "喔",
        "哦",
        "呀",
        "啦",
        "欸",
        "耶",
        "嘛",
        "哈",
        "哈哈",
        "嗯",
        "這",
        "那",
        "这",
        "這個",
        "那個",
        "这个",
        "那个",
        "一個",
        "一个",
        "有",
        "沒",
        "没",
        "沒有",
        "没有",
        "不",
        "很",
        "會",
        "会",
        "要",
        "說",
        "说",
        "跟",
        "把",
        "被",
        "讓",
        "让",
        "給",
        "给",
        "對",
        "对",
        "什麼",
        "什么",
        "怎麼",
        "怎么",
        "為",
        "为",
        "還",
        "还",
        "又",
        "再",
        "之",
        "其",
        "或",
        "但",
        "所以",
        "因為",
        "因为",
        "如果",
        "然後",
        "然后",
        "就是",
        "可以",
        "自己",
        "一下",
        "一些",
        "一樣",
        "一样",
        "這樣",
        "这样",
        "那樣",
        "那样",
        "上",
        "下",
        "中",
        "裡",
        "里",
        "得",
        "地",
        "個",
        "个",
        "些",
        "嗎",
        "記得",
        "记得",
        // Japanese
        "が",
        "は",
        "を",
        "の",
        "に",
        "で",
        "と",
        "も",
        "へ",
        "や",
        "か",
        "ね",
        "よ",
        "な",
        "わ",
        "て",
        "た",
        "だ",
        "です",
        "ます",
        "でした",
        "ました",
        "から",
        "まで",
        "より",
        "けど",
        "って",
        "これ",
        "それ",
        "あれ",
        "この",
        "その",
        "あの",
        "ここ",
        "そこ",
        "する",
        "した",
        "して",
        "いる",
        "ある",
        "ない",
        "なる",
        "こと",
        "もの",
        "よね",
        "かな",
        "でも",
        "私",
        "僕",
        "俺",
        "あなた",
        "さん",
        "ちゃん",
        // English
        "a",
        "an",
        "the",
        "and",
        "or",
        "but",
        "of",
        "to",
        "in",
        "on",
        "at",
        "for",
        "with",
        "by",
        "from",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "am",
        "i",
        "you",
        "he",
        "she",
        "it",
        "we",
        "they",
        "me",
        "him",
        "her",
        "us",
        "them",
        "my",
        "your",
        "his",
        "its",
        "our",
        "their",
        "this",
        "that",
        "these",
        "those",
        "do",
        "does",
        "did",
        "have",
        "has",
        "had",
        "not",
        "no",
        "so",
        "if",
        "then",
        "than",
        "as",
        "what",
        "who",
        "how",
        "why",
        "when",
        "where",
        "which",
        "can",
        "will",
        "would",
        "should",
        "could",
        "just",
        "about",
        "im",
        "dont",
        "lol",
        "ok",
        "okay",
        "yes",
        "yeah",
    ]
    .into_iter()
    .collect()
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Script {
    Han,
    Hiragana,
    Katakana,
    Word,
    Other,
}

fn script(c: char) -> Script {
    match c as u32 {
        0x3005 | 0x3007 | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF => Script::Han,
        0x20000..=0x2FA1F => Script::Han,
        0x3041..=0x309F => Script::Hiragana,
        0x30A0..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9F => Script::Katakana,
        _ if c.is_alphanumeric() => Script::Word,
        _ => Script::Other,
    }
}

/// Lowercases and folds full-width ASCII (`Ｏｗｅｎ` → `owen`).
fn normalize(text: &str) -> String {
    text.chars()
        .map(|c| match c as u32 {
            0xFF01..=0xFF5E => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            0x3000 => ' ',
            _ => c,
        })
        .flat_map(char::to_lowercase)
        .collect()
}

/// Search tokens of `text`, in order of first appearance, without duplicates.
pub fn tokenize(text: &str) -> Vec<String> {
    let text = normalize(text);
    let mut collector = Collector::default();
    let mut run = String::new();
    let mut run_script = Script::Other;
    for c in text.chars() {
        let s = script(c);
        if s != run_script {
            collector.flush(&run, run_script);
            run.clear();
            run_script = s;
        }
        if s != Script::Other {
            run.push(c);
        }
    }
    collector.flush(&run, run_script);
    collector.out
}

#[derive(Default)]
struct Collector {
    out: Vec<String>,
    seen: HashSet<String>,
}

impl Collector {
    fn flush(&mut self, run: &str, s: Script) {
        if run.is_empty() {
            return;
        }
        match s {
            Script::Han => {
                // jieba's dictionary is simplified Chinese; traditional text
                // is converted first so both scripts segment (and match) alike.
                let simplified = fast2s::convert(run);
                for word in JIEBA.cut_for_search(&simplified, true) {
                    self.push(word);
                }
            }
            Script::Hiragana | Script::Katakana | Script::Word => self.push(run),
            Script::Other => {}
        }
    }

    fn push(&mut self, token: &str) {
        let token = token.trim();
        if token.is_empty() || STOP_WORDS.contains(token) {
            return;
        }
        let mut chars = token.chars();
        let first = chars.next().map(script);
        let single = chars.next().is_none();
        // Single Latin letters and lone kana carry no meaning on their own.
        let meaningless = single
            && (matches!(first, Some(Script::Hiragana | Script::Katakana))
                || token.chars().all(|c| c.is_ascii_alphabetic()));
        if !meaningless && self.seen.insert(token.to_owned()) {
            self.out.push(token.to_owned());
        }
    }
}

/// Tokens joined with spaces, as stored in `MemoryRecord::tokens`.
pub fn token_string(text: &str) -> String {
    tokenize(text).join(" ")
}

/// Text with case, width, whitespace and punctuation removed, for
/// near-duplicate detection.
pub fn normalize_for_compare(text: &str) -> String {
    normalize(text)
        .chars()
        .filter(|c| script(*c) != Script::Other)
        .collect()
}

/// Dice coefficient of character bigrams of two normalized strings (0..1).
pub fn text_similarity(a: &str, b: &str) -> f32 {
    let a = normalize_for_compare(a);
    let b = normalize_for_compare(b);
    if a == b {
        return if a.is_empty() { 0.0 } else { 1.0 };
    }
    let grams = |s: &str| -> Vec<(char, char)> {
        let chars: Vec<char> = s.chars().collect();
        if chars.len() == 1 {
            return vec![(chars[0], '\0')];
        }
        chars.windows(2).map(|w| (w[0], w[1])).collect()
    };
    let ga = grams(&a);
    let mut gb = grams(&b);
    if ga.is_empty() || gb.is_empty() {
        return 0.0;
    }
    let total = ga.len() + gb.len();
    let mut common = 0usize;
    for g in &ga {
        if let Some(pos) = gb.iter().position(|x| x == g) {
            gb.swap_remove(pos);
            common += 1;
        }
    }
    (2 * common) as f32 / total as f32
}
