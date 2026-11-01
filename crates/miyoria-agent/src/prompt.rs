//! Prompt assembly, ordered for provider prefix caching: the stable persona
//! prompt first, then the conversation history (which only grows at the end),
//! and the per-turn situation (current time, addressing) last.

use chrono::{DateTime, Datelike, TimeZone};
use miyoria_llm::{ChatMessage, ChatRole};
use miyoria_types::{ContextKey, ContextKind};

use crate::session::HistoryEntry;

const SITUATION: &str = "# 目前情境
- 現在時間:{time}
- 地點:{platform} 的{place}
- 最近在場的人:{present}
- {addressing}

# 規則
- 這是即時聊天,回覆要簡短自然,通常一到三句,除非有人認真問問題。
- 對話紀錄裡別人的訊息格式是「名字: 內容」;你自己的回覆直接寫內容,不要加名字前綴。
- 可以用 <emo:名稱> 標記情緒變化。
- 不需要或不想回的時候,只輸出 <silence/>。";

const ADDRESSED: &str = "有人直接叫你、回覆你或私訊你,請回應對方。";
const AMBIENT: &str = "沒有人直接叫你。只有在你真的想插話時才開口,否則只輸出 <silence/>。";

const VOICE_SITUATION: &str = "# 目前情境
- 現在時間:{time}
- 地點:{platform} 的語音頻道 {channel},大家正在即時語音聊天
- 語音頻道裡的人:{present}
- {addressing}

# 規則
- 你說的話會直接用語音念出來。只說一到兩句簡短、口語的句子。
- 不要用 emoji、顏文字、markdown、列點或網址,只寫念得出來的文字。
- 對話紀錄裡別人說的話格式是「名字(語音): 內容」,是語音辨識的結果,可能有錯字;你自己的話直接寫內容,不要加名字前綴。
- 標著「(被打斷)」的是你講到一半被打斷的話。
- 可以用 <emo:名稱> 標記情緒變化。
- 不需要或不想開口的時候,只輸出 <silence/>。";

const VOICE_ADDRESSED: &str = "有人在叫你或問你問題,請用說的回應對方。";
const VOICE_AMBIENT: &str =
    "沒有人直接叫你,大家在聊天。只有在你真的想插一句話時才開口,否則只輸出 <silence/>。";

/// Appended to her speech that was cut off.
const INTERRUPTED: &str = "(被打斷)";

const CHECK_SYSTEM: &str = "你負責判斷聊天室裡的角色「{name}」現在要不要開口。\
她不是每句都回;只有在話題跟她有關、有人似乎在等她回應、或她插話會自然有趣時才回。\
只回傳 JSON:{\"respond\": true 或 false, \"reason\": \"簡短理由\"}";

const CHECK_USER: &str = "最近的對話(最後幾則是最新的):\n{lines}\n\n{name} 要回應嗎?";

const WEEKDAYS: [&str; 7] = ["一", "二", "三", "四", "五", "六", "日"];

pub struct Situation<'a> {
    pub context: &'a ContextKey,
    /// Display names of people recently active, most recent first (in a
    /// voice channel: the people in it).
    pub present: &'a [String],
    pub direct: bool,
}

pub fn situation_prompt<Tz: TimeZone>(s: &Situation<'_>, now: DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let weekday = WEEKDAYS[now.weekday().num_days_from_monday() as usize];
    let time = format!("{}(星期{weekday})", now.format("%Y-%m-%d %H:%M"));
    let place = match s.context.kind {
        ContextKind::Dm => "私訊".to_owned(),
        ContextKind::Channel => format!("頻道 {}", s.context.channel),
        ContextKind::Thread => format!("討論串 {}", s.context.channel),
        ContextKind::Voice => format!("語音頻道 {}", s.context.channel),
    };
    let present = if s.present.is_empty() {
        "(不清楚)".to_owned()
    } else {
        s.present.join("、")
    };
    if s.context.kind == ContextKind::Voice {
        return VOICE_SITUATION
            .replace("{time}", &time)
            .replace("{platform}", s.context.platform.as_str())
            .replace("{channel}", &s.context.channel)
            .replace("{present}", &present)
            .replace(
                "{addressing}",
                if s.direct {
                    VOICE_ADDRESSED
                } else {
                    VOICE_AMBIENT
                },
            );
    }
    SITUATION
        .replace("{time}", &time)
        .replace("{platform}", s.context.platform.as_str())
        .replace("{place}", &place)
        .replace("{present}", &present)
        .replace("{addressing}", if s.direct { ADDRESSED } else { AMBIENT })
}

/// `[persona, history..., situation]`. Her messages become `assistant`,
/// everyone else's `user` as `"{name}: {text}"` (`"{name}(語音): {text}"` when
/// spoken); consecutive messages of the same role are merged.
pub fn build_messages<'a>(
    persona: &str,
    situation: &str,
    history: impl IntoIterator<Item = &'a HistoryEntry>,
) -> Vec<ChatMessage> {
    let mut out = vec![ChatMessage::system(persona)];
    let mut tail: Vec<ChatMessage> = Vec::new();
    for entry in history {
        let (role, line) = if entry.is_self {
            (ChatRole::Assistant, own_line(entry))
        } else {
            (ChatRole::User, other_line(entry))
        };
        match tail.last_mut() {
            Some(last) if last.role == role => {
                last.content.push('\n');
                last.content.push_str(&line);
            }
            _ => tail.push(match role {
                ChatRole::Assistant => ChatMessage::assistant(line),
                _ => ChatMessage::user(line),
            }),
        }
    }
    out.extend(tail);
    out.push(ChatMessage::system(situation));
    out
}

/// Messages for the `fast` model's respond / stay-quiet check.
pub fn check_messages<'a>(
    name: &str,
    history: impl IntoIterator<Item = &'a HistoryEntry>,
) -> Vec<ChatMessage> {
    let lines: Vec<String> = history
        .into_iter()
        .map(|e| {
            if e.is_self {
                format!("{name}(她自己): {}", own_line(e))
            } else {
                other_line(e)
            }
        })
        .collect();
    vec![
        ChatMessage::system(CHECK_SYSTEM.replace("{name}", name)),
        ChatMessage::user(
            CHECK_USER
                .replace("{lines}", &lines.join("\n"))
                .replace("{name}", name),
        ),
    ]
}

fn own_line(entry: &HistoryEntry) -> String {
    if entry.interrupted {
        format!("{}{INTERRUPTED}", entry.text)
    } else {
        entry.text.clone()
    }
}

fn other_line(entry: &HistoryEntry) -> String {
    if entry.spoken {
        format!("{}(語音): {}", entry.author, entry.text)
    } else {
        format!("{}: {}", entry.author, entry.text)
    }
}

/// Removes a leading `"{her name}:"` the model may copy from the history format.
pub fn clean_reply(text: &str, names: &[String]) -> String {
    let mut text = text.trim();
    for name in names {
        let Some(rest) = strip_prefix_ignore_case(text, name) else {
            continue;
        };
        let rest = rest.trim_start();
        if let Some(rest) = rest.strip_prefix([':', ':']) {
            text = rest.trim_start();
            break;
        }
    }
    text.trim().to_owned()
}

fn strip_prefix_ignore_case<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

/// Splits `text` into chunks of at most `max_chars` characters, preferring
/// line breaks, then sentence ends, then spaces.
pub fn split_message(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(1);
    let mut out = Vec::new();
    let mut rest = text.trim();
    while rest.chars().count() > max_chars {
        let limit = rest
            .char_indices()
            .nth(max_chars)
            .map_or(rest.len(), |(i, _)| i);
        let window = &rest[..limit];
        let min = window.len() / 2;
        let cut = [
            &['\n'][..],
            &['。', '!', '?', '!', '?', '.', '…'][..],
            &[' ', ','][..],
        ]
        .iter()
        .find_map(|set| {
            window
                .char_indices()
                .rev()
                .find(|(i, c)| set.contains(c) && *i >= min)
                .map(|(i, c)| i + c.len_utf8())
        })
        .unwrap_or(limit);
        let (chunk, tail) = rest.split_at(cut);
        let chunk = chunk.trim();
        if !chunk.is_empty() {
            out.push(chunk.to_owned());
        }
        rest = tail.trim_start();
    }
    if !rest.is_empty() {
        out.push(rest.to_owned());
    }
    out
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use miyoria_types::{AccountRef, PlatformId};

    use super::*;

    fn entry(author: &str, text: &str, is_self: bool) -> HistoryEntry {
        HistoryEntry {
            author: author.into(),
            account: AccountRef {
                platform: PlatformId::new("t"),
                id: author.into(),
            },
            text: text.into(),
            ts: Utc::now(),
            is_self,
            pending: None,
            spoken: false,
            interrupted: false,
            turn: None,
        }
    }

    #[test]
    fn builds_role_mapped_merged_history() {
        let history = [
            entry("Owen", "早安", false),
            entry("阿明", "安安", false),
            entry("DS", "早啦", true),
            entry("Owen", "吃了沒", false),
        ];
        let msgs = build_messages("PERSONA", "SITUATION", &history);
        assert_eq!(msgs.len(), 5);
        assert_eq!(msgs[0], ChatMessage::system("PERSONA"));
        assert_eq!(msgs[1], ChatMessage::user("Owen: 早安\n阿明: 安安"));
        assert_eq!(msgs[2], ChatMessage::assistant("早啦"));
        assert_eq!(msgs[3], ChatMessage::user("Owen: 吃了沒"));
        assert_eq!(msgs[4], ChatMessage::system("SITUATION"));
    }

    #[test]
    fn situation_mentions_place_people_and_rules() {
        let ctx = ContextKey {
            platform: PlatformId::new("discord"),
            scope: Some("g".into()),
            channel: "general".into(),
            kind: ContextKind::Channel,
        };
        let present = vec!["Owen".to_owned(), "阿明".to_owned()];
        let now = Utc.with_ymd_and_hms(2026, 11, 1, 14, 3, 0).unwrap();
        let s = situation_prompt(
            &Situation {
                context: &ctx,
                present: &present,
                direct: false,
            },
            now,
        );
        assert!(s.contains("2026-11-01 14:03(星期日)"), "{s}");
        assert!(s.contains("discord 的頻道 general"));
        assert!(s.contains("Owen、阿明"));
        assert!(s.contains(AMBIENT));
        assert!(s.contains("<silence/>"));
    }

    #[test]
    fn marks_spoken_and_interrupted_lines() {
        let history = [
            HistoryEntry {
                spoken: true,
                ..entry("Owen", "妳在嗎", false)
            },
            HistoryEntry {
                spoken: true,
                interrupted: true,
                ..entry("DS", "在啊,幹嘛", true)
            },
            entry("阿明", "打字的", false),
        ];
        let msgs = build_messages("P", "S", &history);
        assert_eq!(msgs[1], ChatMessage::user("Owen(語音): 妳在嗎"));
        assert_eq!(msgs[2], ChatMessage::assistant("在啊,幹嘛(被打斷)"));
        assert_eq!(msgs[3], ChatMessage::user("阿明: 打字的"));
        let check = check_messages("DS", &history);
        assert!(check[1].content.contains("DS(她自己): 在啊,幹嘛(被打斷)"));
        assert!(check[1].content.contains("Owen(語音): 妳在嗎"));
    }

    #[test]
    fn voice_situation_has_speech_rules() {
        let ctx = ContextKey {
            platform: PlatformId::new("discord"),
            scope: Some("g".into()),
            channel: "lounge".into(),
            kind: ContextKind::Voice,
        };
        let present = vec!["Owen".to_owned(), "阿明".to_owned()];
        let now = Utc.with_ymd_and_hms(2026, 11, 1, 22, 0, 0).unwrap();
        let s = situation_prompt(
            &Situation {
                context: &ctx,
                present: &present,
                direct: true,
            },
            now,
        );
        assert!(s.contains("語音頻道 lounge"), "{s}");
        assert!(s.contains("語音頻道裡的人:Owen、阿明"), "{s}");
        assert!(s.contains("一到兩句"));
        assert!(s.contains("emoji"));
        assert!(s.contains("<emo:名稱>"));
        assert!(s.contains(VOICE_ADDRESSED));
        assert!(!s.contains(ADDRESSED));
    }

    #[test]
    fn strips_copied_name_prefix() {
        let names = vec!["DeepSeek-chan".to_owned(), "DeepSeek".to_owned()];
        assert_eq!(clean_reply("DeepSeek-chan: 哼", &names), "哼");
        assert_eq!(clean_reply(" deepseek:早啦 ", &names), "早啦");
        assert_eq!(clean_reply("DeepSeek 是我", &names), "DeepSeek 是我");
        assert_eq!(clean_reply("說:好", &names), "說:好");
    }

    #[test]
    fn splits_long_messages() {
        assert_eq!(split_message("短短的", 1900), ["短短的"]);
        assert!(split_message("   ", 10).is_empty());

        let text = format!("{}。{}", "啊".repeat(8), "嗯".repeat(8));
        assert_eq!(
            split_message(&text, 10),
            [format!("{}。", "啊".repeat(8)), "嗯".repeat(8)]
        );

        let hard = "x".repeat(25);
        let parts = split_message(&hard, 10);
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.chars().count() <= 10));
        assert_eq!(parts.concat(), hard);

        let lines = format!("{}\n{}", "a b c d e", "f".repeat(8));
        assert_eq!(split_message(&lines, 12), ["a b c d e", &"f".repeat(8)]);
    }
}
