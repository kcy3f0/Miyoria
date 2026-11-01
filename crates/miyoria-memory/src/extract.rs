//! The consolidation prompt and lenient parsing of the summarizer's JSON.

use chrono::{DateTime, FixedOffset, Utc};
use miyoria_store::LogEntry;
use serde_json::Value;

/// Who a fact or followup is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubjectName {
    /// Herself.
    Myself,
    Named(String),
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExEpisode {
    pub summary: String,
    pub importance: f32,
    pub emotion: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExFact {
    pub subject: SubjectName,
    pub statement: String,
    pub importance: f32,
    pub confidence: f32,
    pub global: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExNote {
    pub note: String,
    pub importance: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExFollowup {
    pub subject: SubjectName,
    pub about: String,
    pub due_in_hours: f64,
}

/// What the summarizer extracted from one stretch of conversation.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Extraction {
    pub episode: Option<ExEpisode>,
    pub facts: Vec<ExFact>,
    pub self_notes: Vec<ExNote>,
    pub followups: Vec<ExFollowup>,
    /// Items that were present but malformed.
    pub skipped: usize,
}

/// System prompt: she reviews the conversation and writes her own memories.
pub fn system_prompt(self_label: &str) -> String {
    format!(
        r#"你正在回想自己剛剛參與的一段對話,把值得記住的事整理成「你自己的記憶」。
逐字稿裡標成「{self_label}」的是你自己說的話,其他人用他們的名字標示。

用你自己的角度寫(第一人稱「我」),提到別人時一定寫出他們的名字,讓每一條日後單獨看也看得懂。
只記對話裡真的出現的資訊,不要猜測或補充;寒暄、玩笑、沒內容的閒聊不用記。

只輸出一個 JSON 物件,格式如下:
{{
  "episode": {{"summary": "一兩句話描述這段對話發生了什麼(我的角度)", "importance": 0.0到1.0, "emotion": "我當時的心情,一個詞"}} 或 null,
  "facts": [{{"subject_name": "這件事是關於誰(用逐字稿裡的名字),關於我自己就寫 \"self\"", "statement": "例如:Owen 喜歡吃拉麵", "importance": 0.0到1.0, "confidence": 0.0到1.0, "global": true 或 false}}],
  "self_notes": [{{"note": "我說過的承諾、表達過的意見、我自己的經歷,例如:我答應 Owen 下次陪他打 Minecraft", "importance": 0.0到1.0}}],
  "followups": [{{"subject_name": "要追問誰", "about": "之後想問或提起的事,例如:問 Owen 明天的考試考得怎樣", "due_in_hours": 幾小時後適合提起}}]
}}

規則:
- importance:1 是非常重要(重大消息、強烈喜好、承諾),0.1 是幾乎不重要。
- confidence:對方明確說的接近 1,只是暗示或玩笑話就低一點。
- global 只在「名字、希望我怎麼稱呼他、代名詞」這類到哪裡都適用、而且一點都不私密的事實才設 true,其他一律 false。
- 沒有值得記的就給空陣列或 null,不要硬湊。"#
    )
}

/// Transcript given to the summarizer, one line per log entry.
pub fn transcript(
    lines: &[LogEntry],
    self_label: &str,
    private: bool,
    utc_offset_minutes: i32,
) -> String {
    let tz = FixedOffset::east_opt(utc_offset_minutes.clamp(-18 * 60, 18 * 60) * 60)
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC offset"));
    let mut out = String::new();
    out.push_str(if private {
        "地點:私訊(一對一)\n"
    } else {
        "地點:伺服器頻道\n"
    });
    if let (Some(first), Some(last)) = (lines.first(), lines.last()) {
        out.push_str(&format!(
            "時間:{} 到 {}\n",
            local(first.ts, &tz),
            local(last.ts, &tz)
        ));
    }
    out.push_str("\n逐字稿:\n");
    for entry in lines {
        let name = if entry.is_self {
            self_label
        } else {
            entry.author_name.as_str()
        };
        let text = entry.text.replace('\n', " ");
        out.push_str(&format!("{name}: {text}\n"));
    }
    out
}

fn local(ts: DateTime<Utc>, tz: &FixedOffset) -> String {
    ts.with_timezone(tz).format("%Y-%m-%d %H:%M").to_string()
}

/// Parses the summarizer's answer. Tolerates code fences, prose around the
/// object, string numbers and 0..10 / 0..100 scales; malformed items are
/// skipped (counted in `skipped`). Fails only when there is no JSON object.
pub fn parse_extraction(text: &str) -> anyhow::Result<Extraction> {
    let value = find_object(text)?;
    let mut out = Extraction::default();

    match value.get("episode") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if !s.trim().is_empty() => {
            out.episode = Some(ExEpisode {
                summary: s.trim().to_owned(),
                importance: 0.3,
                emotion: None,
            });
        }
        Some(Value::Object(map)) => match str_field(map, &["summary", "content", "text"]) {
            Some(summary) => {
                out.episode = Some(ExEpisode {
                    summary,
                    importance: unit(map.get("importance")).unwrap_or(0.3),
                    emotion: str_field(map, &["emotion", "mood"]),
                });
            }
            None => out.skipped += 1,
        },
        Some(_) => out.skipped += 1,
    }

    for item in array(&value, "facts") {
        let Some(map) = item.as_object() else {
            out.skipped += 1;
            continue;
        };
        let Some(statement) = str_field(map, &["statement", "fact", "content"]) else {
            out.skipped += 1;
            continue;
        };
        out.facts.push(ExFact {
            subject: subject(map),
            statement,
            importance: unit(map.get("importance")).unwrap_or(0.5),
            confidence: unit(map.get("confidence")).unwrap_or(0.7),
            global: boolean(map.get("global")),
        });
    }

    for item in array(&value, "self_notes") {
        let note = match item {
            Value::String(s) if !s.trim().is_empty() => Some((s.trim().to_owned(), 0.4)),
            Value::Object(map) => str_field(map, &["note", "content", "statement"])
                .map(|n| (n, unit(map.get("importance")).unwrap_or(0.4))),
            _ => None,
        };
        match note {
            Some((note, importance)) => out.self_notes.push(ExNote { note, importance }),
            None => out.skipped += 1,
        }
    }

    for item in array(&value, "followups") {
        let Some(map) = item.as_object() else {
            out.skipped += 1;
            continue;
        };
        let Some(about) = str_field(map, &["about", "content", "topic"]) else {
            out.skipped += 1;
            continue;
        };
        let hours = number(map.get("due_in_hours")).unwrap_or(24.0);
        out.followups.push(ExFollowup {
            subject: subject(map),
            about,
            due_in_hours: hours.clamp(0.0, 24.0 * 90.0),
        });
    }
    Ok(out)
}

fn find_object(text: &str) -> anyhow::Result<Value> {
    let trimmed = text.trim();
    if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(trimmed) {
        return Ok(v);
    }
    let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) else {
        anyhow::bail!("no JSON object in summarizer output");
    };
    if end <= start {
        anyhow::bail!("no JSON object in summarizer output");
    }
    match serde_json::from_str::<Value>(&trimmed[start..=end]) {
        Ok(v @ Value::Object(_)) => Ok(v),
        Ok(_) => anyhow::bail!("summarizer output is not a JSON object"),
        Err(e) => anyhow::bail!("invalid JSON from summarizer: {e}"),
    }
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn str_field(map: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| map.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn subject(map: &serde_json::Map<String, Value>) -> SubjectName {
    match str_field(map, &["subject_name", "subject", "name"]) {
        None => SubjectName::Unknown,
        Some(name) => {
            let lower = name.to_lowercase();
            if ["self", "me", "myself", "我", "我自己"].contains(&lower.as_str()) {
                SubjectName::Myself
            } else {
                SubjectName::Named(name)
            }
        }
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('%').parse().ok(),
        _ => None,
    }
    .filter(|n: &f64| n.is_finite())
}

/// A 0..1 score; 0..10 and 0..100 scales are rescaled.
fn unit(value: Option<&Value>) -> Option<f32> {
    let n = number(value)?;
    let n = if n > 10.0 {
        n / 100.0
    } else if n > 1.0 {
        n / 10.0
    } else {
        n
    };
    Some(n.clamp(0.0, 1.0) as f32)
}

fn boolean(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.trim().to_lowercase().as_str(), "true" | "yes" | "1"),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => false,
    }
}
