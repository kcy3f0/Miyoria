//! Cheap keyword rules (zh / ja / en) giving immediate small deltas. The
//! batched LLM appraisal does the real judging; these only react fast to the
//! obvious cases.

use super::rel::EventKind;

const GREETING: &[&str] = &[
    "早安",
    "午安",
    "晚安",
    "你好",
    "妳好",
    "哈囉",
    "安安",
    "早啊",
    "嗨",
    "おはよう",
    "こんにちは",
    "こんばんは",
    "おやすみ",
    "hello",
    "hi",
    "hey",
    "good morning",
    "good night",
    "good evening",
];
const THANKS: &[&str] = &[
    "謝謝",
    "感謝",
    "多謝",
    "謝啦",
    "謝了",
    "感恩",
    "ありがとう",
    "サンキュー",
    "thank",
    "thanks",
    "thx",
    "3q",
];
const PRAISE: &[&str] = &[
    "好可愛",
    "可愛",
    "好棒",
    "很棒",
    "厲害",
    "好聰明",
    "聰明",
    "最棒",
    "最好了",
    "喜歡你",
    "愛你",
    "好強",
    "かわいい",
    "可愛い",
    "すごい",
    "えらい",
    "天才",
    "大好き",
    "cute",
    "awesome",
    "amazing",
    "smart",
    "good job",
    "well done",
    "love you",
    "the best",
];
const APOLOGY: &[&str] = &[
    "對不起",
    "抱歉",
    "不好意思",
    "ごめん",
    "すみません",
    "sorry",
    "my bad",
];
const RUDE: &[&str] = &[
    "笨蛋",
    "好煩",
    "煩欸",
    "煩死",
    "吵死了",
    "閉嘴",
    "ばか",
    "バカ",
    "うるさい",
    "baka",
    "annoying",
    "shut up",
];
const INSULT: &[&str] = &[
    "白痴",
    "白癡",
    "智障",
    "廢物",
    "垃圾",
    "低能",
    "腦殘",
    "醜八怪",
    "賤",
    "婊",
    "幹你",
    "操你",
    "うざい",
    "きもい",
    "ブス",
    "黙れ",
    "stupid",
    "idiot",
    "trash",
    "useless",
    "dumb",
    "fuck you",
    "ugly",
    "bitch",
    "moron",
];
const HARASSMENT: &[&str] = &[
    "去死",
    "給我死",
    "殺了你",
    "殺死你",
    "肉搜",
    "人肉",
    "死ね",
    "殺す",
    "kill yourself",
    "kys",
    "kill you",
];
const FLIRT_TOO_FAR: &[&str] = &[
    "胸部",
    "奶子",
    "內褲",
    "脫衣",
    "脫掉",
    "做愛",
    "上床",
    "色色",
    "裸照",
    "摸你",
    "舔你",
    "パンツ",
    "おっぱい",
    "エッチしよう",
    "nudes",
    "boobs",
    "panties",
    "sex with",
    "strip for",
];

/// Characters that negate a following CJK keyword ("不可愛", "不謝").
const NEGATIONS: &[char] = &['不', '沒', '別', '非'];

/// Greetings that double as "so ..." before an adjective.
const HOW_PREFIXES: &[&str] = &["你好", "妳好"];
const GREETING_TAILS: &[char] = &['啊', '呀', '喔', '哦', '嗎', '唷', '耶'];

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}')
}

/// Event kinds whose keywords appear in `text`, each at most once.
pub fn classify(text: &str) -> Vec<EventKind> {
    let lower = text.to_lowercase();
    let table: [(EventKind, &[&str]); 8] = [
        (EventKind::Harassment, HARASSMENT),
        (EventKind::FlirtTooFar, FLIRT_TOO_FAR),
        (EventKind::Insult, INSULT),
        (EventKind::Rude, RUDE),
        (EventKind::Apology, APOLOGY),
        (EventKind::Thanks, THANKS),
        (EventKind::Praise, PRAISE),
        (EventKind::Greeting, GREETING),
    ];
    let mut out = Vec::new();
    for (kind, words) in table {
        if words.iter().any(|w| contains_keyword(&lower, w)) {
            out.push(kind);
        }
    }
    // An insult also counts as rude; keep only the stronger one.
    if out.contains(&EventKind::Insult) || out.contains(&EventKind::Harassment) {
        out.retain(|k| *k != EventKind::Rude);
    }
    if out.contains(&EventKind::Harassment) {
        out.retain(|k| *k != EventKind::Insult);
    }
    out
}

/// ASCII keywords must sit on word boundaries; CJK keywords must not follow a
/// negation.
fn contains_keyword(text: &str, word: &str) -> bool {
    let ascii = word.is_ascii();
    text.match_indices(word).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + word.len()..].chars().next();
        if ascii {
            let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_ascii_alphanumeric());
            boundary(before) && boundary(after)
        } else if before.is_some_and(|c| NEGATIONS.contains(&c)) {
            false
        } else if HOW_PREFIXES.contains(&word) {
            // "你好可愛" means "you are so cute", not "hello".
            after.is_none_or(|c| !is_cjk(c) || GREETING_TAILS.contains(&c))
        } else {
            true
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_kinds_in_three_languages() {
        assert_eq!(classify("DS醬謝謝你!"), vec![EventKind::Thanks]);
        assert_eq!(
            classify("ありがとう、かわいいね"),
            vec![EventKind::Thanks, EventKind::Praise]
        );
        assert_eq!(
            classify("Thanks, you're awesome"),
            vec![EventKind::Thanks, EventKind::Praise]
        );
        assert_eq!(classify("早安~"), vec![EventKind::Greeting]);
        assert_eq!(classify("你這個智障"), vec![EventKind::Insult]);
        assert_eq!(classify("閉嘴啦智障"), vec![EventKind::Insult]);
        assert_eq!(classify("去死啦白痴"), vec![EventKind::Harassment]);
        assert_eq!(classify("給我看內褲"), vec![EventKind::FlirtTooFar]);
        assert_eq!(classify("baka"), vec![EventKind::Rude]);
    }

    #[test]
    fn respects_boundaries_and_negation() {
        assert!(
            classify("this is high quality").is_empty(),
            "hi inside a word"
        );
        assert!(classify("你一點都不可愛").is_empty());
        assert!(classify("不謝").is_empty());
        assert!(classify("今天天氣不錯").is_empty());
        assert_eq!(classify("hi there"), vec![EventKind::Greeting]);
        assert_eq!(classify("你好可愛"), vec![EventKind::Praise]);
        assert_eq!(classify("你好啊 DS醬"), vec![EventKind::Greeting]);
    }
}
