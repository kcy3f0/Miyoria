//! Text clean-up around ASR and TTS.

use zhconv::{Variant, zhconv};

/// Converts Simplified Chinese to Traditional Chinese (Taiwan phrasing).
pub fn to_traditional(text: &str) -> String {
    zhconv(text, Variant::ZhTW)
}

/// Phrases ASR models (Whisper-style) invent on silence or noise. Compared
/// after Traditional conversion, lower-cased, without spaces and punctuation.
const HALLUCINATION_EXACT: &[&str] = &[
    "謝謝觀看",
    "謝謝大家觀看",
    "感謝觀看",
    "謝謝收看",
    "請訂閱",
    "記得訂閱",
    "thankyouforwatching",
    "thanksforwatching",
    "pleasesubscribe",
    "ご視聴ありがとうございました",
];

const HALLUCINATION_CONTAINS: &[&str] = &[
    "字幕由",
    "字幕提供",
    "字幕製作",
    "字幕志願者",
    "中文字幕",
    "請不吝點贊",
    "點贊訂閱",
    "訂閱轉發",
    "打賞支持",
    "明鏡與點點",
    "優優獨播劇場",
    "amaraorg",
    "subtitlesby",
];

fn normalize(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// No letters, digits or CJK characters at all.
pub fn is_punctuation_only(text: &str) -> bool {
    !text.chars().any(char::is_alphanumeric)
}

/// Known ASR hallucination (`extra` adds configured phrases, matched as
/// substrings).
pub fn is_hallucination(text: &str, extra: &[String]) -> bool {
    let n = normalize(&to_traditional(text));
    if n.is_empty() {
        return true;
    }
    HALLUCINATION_EXACT.contains(&n.as_str())
        || HALLUCINATION_CONTAINS.iter().any(|p| n.contains(p))
        || extra
            .iter()
            .map(|p| normalize(&to_traditional(p)))
            .any(|p| !p.is_empty() && n.contains(&p))
}

/// Cleans an ASR transcript. Returns `None` when it should be dropped.
pub fn clean_transcript(text: &str, traditional: bool, extra: &[String]) -> Option<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || is_punctuation_only(&text) || is_hallucination(&text, extra) {
        return None;
    }
    Some(if traditional {
        to_traditional(&text)
    } else {
        text
    })
}

/// Longest `<...>` treated as a markup tag.
const MAX_TAG_LEN: usize = 48;

/// Removes expression markup the agent may have left in (`<emo:happy>`,
/// `<pause 300/>`, `<silence/>`, other short `<word ...>` tags) and collapses
/// whitespace.
pub fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('>').filter(|&e| e <= MAX_TAG_LEN);
        match end {
            Some(end) if looks_like_tag(&after[..end]) => {
                out.push(' ');
                rest = &after[end + 1..];
            }
            _ => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn looks_like_tag(body: &str) -> bool {
    let body = body.trim_start_matches('/');
    body.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && !body.contains('<')
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " :=_-/.\"'".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_to_taiwan_traditional() {
        assert_eq!(to_traditional("你好,这个软件很好用"), "你好,這個軟體很好用");
        assert_eq!(to_traditional("早安"), "早安");
        assert_eq!(to_traditional("hello 123"), "hello 123");
    }

    #[test]
    fn detects_hallucinations() {
        for h in [
            "谢谢观看",
            "謝謝觀看!",
            "字幕由Amara.org社区提供",
            "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
            "Thank you for watching.",
            "。。。",
        ] {
            assert!(is_hallucination(h, &[]), "{h}");
        }
        for ok in ["謝謝你", "我看了字幕", "今天要做什麼?", "thank you"] {
            assert!(!is_hallucination(ok, &[]), "{ok}");
        }
        assert!(is_hallucination("嗯嗯请关注频道", &["關注頻道".to_owned()]));
    }

    #[test]
    fn cleans_transcripts() {
        assert_eq!(
            clean_transcript("  这个  游戏 ", true, &[]).as_deref(),
            Some("這個 遊戲")
        );
        assert_eq!(
            clean_transcript("这个", false, &[]).as_deref(),
            Some("这个")
        );
        assert_eq!(clean_transcript("", true, &[]), None);
        assert_eq!(clean_transcript("……?!", true, &[]), None);
        assert_eq!(clean_transcript("谢谢观看", true, &[]), None);
    }

    #[test]
    fn strips_expression_tags() {
        assert_eq!(
            strip_tags("<emo:happy>欸你回來啦!<pause 300/>今天怎樣?<silence/>"),
            "欸你回來啦! 今天怎樣?"
        );
        assert_eq!(strip_tags("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2");
        assert_eq!(strip_tags("<3 你"), "<3 你");
        assert_eq!(strip_tags("<emo:smug"), "<emo:smug");
        assert_eq!(strip_tags("<<emo:sad>>"), "< >");
    }
}
