//! Attention: should she respond to this turn?
//!
//! Layer 1 are hard rules (channel mode, direct address, anti-spam share,
//! cooldown), layer 2 a cheap salience score. Layer 3, the optional `fast`
//! LLM check for ambient gray-zone turns, runs in the turn itself.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use miyoria_types::{ContextKind, IncomingMessage};

use crate::config::{Activeness, AttentionConfig, ChannelMode};
use crate::session::Session;

/// Source of uniform randomness in `[0, 1)` for the final decision.
pub trait RandomSource: Send + Sync {
    fn next_f32(&self) -> f32;
}

/// Small deterministic generator (SplitMix64).
pub struct SeededRandom {
    state: Mutex<u64>,
}

impl SeededRandom {
    pub fn new(seed: u64) -> Self {
        Self {
            state: Mutex::new(seed),
        }
    }

    pub fn from_entropy() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos() as u64);
        Self::new(nanos ^ 0x9E37_79B9_7F4A_7C15)
    }
}

impl RandomSource for SeededRandom {
    fn next_f32(&self) -> f32 {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 40) as f32 / (1u64 << 24) as f32
    }
}

/// What layers 1 and 2 concluded.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Gate {
    Ignore,
    /// Respond with this probability.
    Sample(f32),
    /// Gray zone: ask the `fast` model, otherwise sample with the score.
    AskLlm,
}

#[derive(Clone, Debug)]
pub struct Assessment {
    pub direct: bool,
    pub score: f32,
    pub gate: Gate,
    pub reasons: Vec<String>,
}

pub struct AttentionInput<'a> {
    pub config: &'a AttentionConfig,
    pub mode: ChannelMode,
    /// Scales the ambient reply probability and cooldown.
    pub activeness: Activeness,
    pub names: &'a [String],
    /// The profile's interests; matched like `config.keywords`.
    pub interests: &'a [String],
    pub max_share: f32,
    pub session: &'a Session,
    /// The messages that make up this turn (already in the session history).
    pub inputs: &'a [IncomingMessage],
    pub now: DateTime<Utc>,
}

/// Why a message addresses her directly, if it does.
pub fn direct_reason(msg: &IncomingMessage, names: &[String]) -> Option<String> {
    if msg.context().kind == ContextKind::Dm {
        return Some("dm".into());
    }
    if msg.mentions_self {
        return Some("mention".into());
    }
    if msg.reply_to_self {
        return Some("reply".into());
    }
    let lower = msg.text.to_lowercase();
    names
        .iter()
        .find(|n| !n.is_empty() && lower.contains(&n.to_lowercase()))
        .map(|n| format!("name `{n}`"))
}

pub fn assess(input: &AttentionInput<'_>) -> Assessment {
    let cfg = input.config;
    let mut reasons = vec![format!("mode {}", input.mode)];
    let direct = input
        .inputs
        .iter()
        .find_map(|m| direct_reason(m, input.names));
    if let Some(why) = &direct {
        reasons.push(format!("direct: {why}"));
    }
    let score = salience(input, direct.is_some(), &mut reasons);
    let direct = direct.is_some();
    let done = |gate, reasons| Assessment {
        direct,
        score,
        gate,
        reasons,
    };

    match input.mode {
        ChannelMode::Off => return done(Gate::Ignore, reasons),
        ChannelMode::Always => return done(Gate::Sample(1.0), reasons),
        ChannelMode::MentionOnly | ChannelMode::Ambient if direct => {
            return done(Gate::Sample(cfg.direct_probability), reasons);
        }
        ChannelMode::MentionOnly => {
            reasons.push("not addressed".into());
            return done(Gate::Ignore, reasons);
        }
        ChannelMode::Ambient => {}
    }

    let activeness = input.activeness;
    if activeness != Activeness::Medium {
        reasons.push(format!("activeness {activeness}"));
    }
    let cooldown_ms = (cfg.cooldown_ms as f32 * activeness.cooldown_factor()) as i64;
    if let Some(last) = input.session.last_self_at() {
        let since = input.now.signed_duration_since(last);
        if since.num_milliseconds() < cooldown_ms {
            reasons.push(format!(
                "cooldown ({}ms since she spoke)",
                since.num_milliseconds()
            ));
            return done(Gate::Ignore, reasons);
        }
    }
    let share = input.session.self_share(cfg.recent_window);
    if share > input.max_share {
        reasons.push(format!(
            "anti-spam: her share {share:.2} > {:.2}",
            input.max_share
        ));
        return done(Gate::Ignore, reasons);
    }
    if score < cfg.gray_low {
        reasons.push(format!("score {score:.2} < {:.2}", cfg.gray_low));
        done(Gate::Ignore, reasons)
    } else if score >= cfg.gray_high {
        done(Gate::Sample(activeness.scale(score)), reasons)
    } else if cfg.llm_check {
        reasons.push("gray zone: asking fast model".into());
        done(Gate::AskLlm, reasons)
    } else {
        done(Gate::Sample(activeness.scale(score)), reasons)
    }
}

fn salience(input: &AttentionInput<'_>, direct: bool, reasons: &mut Vec<String>) -> f32 {
    let mut score = 0.05;
    let mut add = |weight: f32, why: &str| {
        score += weight;
        reasons.push(format!("{why} {weight:+.2}"));
    };
    if direct {
        add(0.6, "direct");
    }
    let texts: Vec<String> = input.inputs.iter().map(|m| m.text.to_lowercase()).collect();
    if texts.iter().any(|t| is_question(t)) {
        add(0.15, "question");
    }
    let keyword = input
        .config
        .keywords
        .iter()
        .chain(input.interests)
        .find(|k| texts.iter().any(|t| mentions_topic(t, k)));
    if let Some(k) = keyword {
        add(0.2, &format!("topic `{k}`"));
    }

    // Was she part of the conversation right before this turn?
    let history = input.session.history();
    let before = history.len().saturating_sub(input.inputs.len());
    let follow_up = history
        .iter()
        .take(before)
        .rev()
        .take(3)
        .find(|e| e.is_self)
        .is_some_and(|e| input.now.signed_duration_since(e.ts).num_seconds() < 180);
    if follow_up {
        add(0.35, "follow-up to her");
    }
    match input.session.last_self_at() {
        None => add(0.05, "has not spoken yet"),
        Some(t) if input.now.signed_duration_since(t).num_minutes() >= 30 => {
            add(0.05, "quiet for a while");
        }
        Some(_) => {}
    }
    if input.inputs.len() > 1 {
        add(0.05, "several messages");
    }
    let mut people: Vec<_> = input
        .session
        .recent(10)
        .filter(|e| !e.is_self)
        .map(|e| &e.account)
        .collect();
    people.sort_by(|a, b| a.id.cmp(&b.id));
    people.dedup();
    if people.len() <= 2 {
        add(0.1, "small group");
    }
    score.clamp(0.0, 1.0)
}

/// `text` (lower-cased) mentions `topic`. ASCII words such as `AI` must stand
/// alone, so they do not match inside `said`; other topics match anywhere.
fn mentions_topic(text: &str, topic: &str) -> bool {
    let topic = topic.trim().to_lowercase();
    if topic.is_empty() {
        return false;
    }
    if !topic.chars().all(|c| c.is_ascii_alphanumeric()) {
        return text.contains(&topic);
    }
    text.match_indices(&topic).any(|(i, m)| {
        let before = text[..i].chars().next_back();
        let after = text[i + m.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_alphanumeric())
            && !after.is_some_and(|c| c.is_ascii_alphanumeric())
    })
}

fn is_question(text: &str) -> bool {
    let t = text.trim_end_matches(|c: char| c.is_whitespace() || "~～!！。.…".contains(c));
    t.contains(['?', '?']) || t.ends_with(['嗎', '呢', '吧']) || {
        [
            "什麼",
            "怎麼",
            "幹嘛",
            "為什麼",
            "為啥",
            "誰",
            "哪裡",
            "哪個",
            "how ",
            "what ",
            "why ",
        ]
        .iter()
        .any(|w| t.contains(w))
    }
}

/// Samples the final decision; the roll is `None` when the outcome was certain.
pub fn decide(probability: f32, random: &dyn RandomSource) -> (bool, Option<f32>) {
    if probability >= 1.0 {
        return (true, None);
    }
    if probability <= 0.0 {
        return (false, None);
    }
    let roll = random.next_f32();
    (roll < probability, Some(roll))
}

#[cfg(test)]
mod tests {
    use miyoria_types::{AccountRef, ActionId, Author, ContextKey, MessageRef, PlatformId};

    use super::*;

    fn ctx(kind: ContextKind) -> ContextKey {
        ContextKey {
            platform: PlatformId::new("t"),
            scope: (kind != ContextKind::Dm).then(|| "g".into()),
            channel: "c".into(),
            kind,
        }
    }

    fn msg(kind: ContextKind, who: &str, text: &str) -> IncomingMessage {
        IncomingMessage {
            id: MessageRef {
                context: ctx(kind),
                id: "1".into(),
            },
            author: Author {
                account: AccountRef {
                    platform: PlatformId::new("t"),
                    id: who.into(),
                },
                display_name: who.into(),
                is_bot: false,
            },
            text: text.into(),
            mentions_self: false,
            reply_to_self: false,
            attachments: Vec::new(),
            ts: Utc::now(),
        }
    }

    fn run(
        cfg: &AttentionConfig,
        mode: ChannelMode,
        session: &Session,
        inputs: &[IncomingMessage],
    ) -> Assessment {
        run_with(cfg, mode, Activeness::Medium, &[], session, inputs)
    }

    fn run_with(
        cfg: &AttentionConfig,
        mode: ChannelMode,
        activeness: Activeness,
        interests: &[String],
        session: &Session,
        inputs: &[IncomingMessage],
    ) -> Assessment {
        let names = vec!["DeepSeek-chan".to_owned(), "小鯨魚".to_owned()];
        assess(&AttentionInput {
            config: cfg,
            mode,
            activeness,
            names: &names,
            interests,
            max_share: 0.3,
            session,
            inputs,
            now: Utc::now(),
        })
    }

    fn session_with(msgs: &[IncomingMessage]) -> Session {
        let mut s = Session::new(ctx(ContextKind::Channel), 50);
        for m in msgs {
            s.record_message(m, false);
        }
        s
    }

    #[test]
    fn direct_address_kinds() {
        let names = vec!["DeepSeek".to_owned()];
        let mut m = msg(ContextKind::Channel, "a", "hello");
        assert_eq!(direct_reason(&m, &names), None);
        m.text = "deepseek 你好".into();
        assert_eq!(direct_reason(&m, &names).unwrap(), "name `DeepSeek`");
        m.text = "x".into();
        m.reply_to_self = true;
        assert_eq!(direct_reason(&m, &names).unwrap(), "reply");
        m.mentions_self = true;
        assert_eq!(direct_reason(&m, &names).unwrap(), "mention");
        let dm = msg(ContextKind::Dm, "a", "x");
        assert_eq!(direct_reason(&dm, &names).unwrap(), "dm");
    }

    #[test]
    fn modes() {
        let cfg = AttentionConfig::default();
        let plain = vec![msg(ContextKind::Channel, "a", "今天好熱")];
        let named = vec![msg(ContextKind::Channel, "a", "小鯨魚早安")];
        let s = session_with(&plain);
        assert_eq!(run(&cfg, ChannelMode::Off, &s, &named).gate, Gate::Ignore);
        assert_eq!(
            run(&cfg, ChannelMode::Always, &s, &plain).gate,
            Gate::Sample(1.0)
        );
        assert_eq!(
            run(&cfg, ChannelMode::MentionOnly, &s, &plain).gate,
            Gate::Ignore
        );
        let a = run(&cfg, ChannelMode::MentionOnly, &s, &named);
        assert!(a.direct);
        assert_eq!(a.gate, Gate::Sample(1.0));
        assert_eq!(
            run(&cfg, ChannelMode::Ambient, &s, &named).gate,
            Gate::Sample(1.0)
        );
    }

    #[test]
    fn ambient_scoring_and_gray_zone() {
        let mut cfg = AttentionConfig {
            keywords: vec!["鯨魚".into()],
            ..Default::default()
        };
        let busy: Vec<_> = (0..6)
            .map(|i| msg(ContextKind::Channel, &format!("p{i}"), "閒聊"))
            .collect();
        let s = session_with(&busy);
        let a = run(&cfg, ChannelMode::Ambient, &s, &busy[5..]);
        assert_eq!(a.gate, Gate::Ignore, "{:?}", a.reasons);

        let q = vec![msg(ContextKind::Channel, "p1", "你們看過鯨魚嗎?")];
        let mut s2 = session_with(&busy);
        s2.record_message(&q[0], false);
        let a = run(&cfg, ChannelMode::Ambient, &s2, &q);
        assert_eq!(a.gate, Gate::AskLlm, "{:?}", a.reasons);
        cfg.llm_check = false;
        assert!(matches!(
            run(&cfg, ChannelMode::Ambient, &s2, &q).gate,
            Gate::Sample(_)
        ));
    }

    #[test]
    fn follow_up_cooldown_and_share() {
        let cfg = AttentionConfig {
            llm_check: false,
            cooldown_ms: 0,
            ..Default::default()
        };
        let mut s = session_with(&[msg(ContextKind::Channel, "a", "早")]);
        let me = AccountRef {
            platform: PlatformId::new("t"),
            id: "her".into(),
        };
        s.record_own("Her", me.clone(), "早啊", ActionId::new(), Utc::now());
        let reply = vec![msg(ContextKind::Channel, "a", "妳今天幹嘛")];
        s.record_message(&reply[0], false);
        let a = run(&cfg, ChannelMode::Ambient, &s, &reply);
        assert!(a.reasons.iter().any(|r| r.starts_with("follow-up")));
        assert!(matches!(a.gate, Gate::Sample(p) if p >= 0.6), "{:?}", a);

        let strict = AttentionConfig {
            cooldown_ms: 60_000,
            ..cfg.clone()
        };
        let a = run(&strict, ChannelMode::Ambient, &s, &reply);
        assert_eq!(a.gate, Gate::Ignore);
        assert!(a.reasons.iter().any(|r| r.starts_with("cooldown")));

        for _ in 0..10 {
            s.record_own("Her", me.clone(), "spam", ActionId::new(), Utc::now());
        }
        let a = run(&cfg, ChannelMode::Ambient, &s, &reply);
        assert_eq!(a.gate, Gate::Ignore);
        assert!(a.reasons.iter().any(|r| r.starts_with("anti-spam")));
    }

    #[test]
    fn interests_raise_salience() {
        let cfg = AttentionConfig {
            llm_check: false,
            ..Default::default()
        };
        let busy: Vec<_> = (0..6)
            .map(|i| msg(ContextKind::Channel, &format!("p{i}"), "閒聊"))
            .collect();
        let q = vec![msg(ContextKind::Channel, "p1", "昨天去看了深海紀錄片")];
        let mut s = session_with(&busy);
        s.record_message(&q[0], false);
        let plain = run(&cfg, ChannelMode::Ambient, &s, &q);
        let interests = vec!["Minecraft".to_owned(), "深海".to_owned()];
        let a = run_with(
            &cfg,
            ChannelMode::Ambient,
            Activeness::Medium,
            &interests,
            &s,
            &q,
        );
        assert!(a.score > plain.score + 0.15, "{:?}", a.reasons);
        assert!(a.reasons.iter().any(|r| r.contains("topic `深海`")));
    }

    #[test]
    fn ascii_topics_match_whole_words() {
        assert!(mentions_topic("我在玩ai畫圖", "AI"));
        assert!(mentions_topic("ai is cool", "AI"));
        assert!(!mentions_topic("she said hi", "AI"));
        assert!(mentions_topic("今天玩 minecraft!", "Minecraft"));
        assert!(mentions_topic("鯨魚好大", "魚"));
        assert!(!mentions_topic("anything", " "));
    }

    #[test]
    fn activeness_scales_ambient_probability_and_cooldown() {
        let cfg = AttentionConfig {
            llm_check: false,
            cooldown_ms: 10_000,
            ..Default::default()
        };
        let q = vec![msg(ContextKind::Channel, "a", "你們看過鯨魚嗎?")];
        let s = session_with(&q);
        let sample = |a: &Assessment| match a.gate {
            Gate::Sample(p) => p,
            other => panic!("{other:?}"),
        };
        let medium = sample(&run(&cfg, ChannelMode::Ambient, &s, &q));
        let low = sample(&run_with(
            &cfg,
            ChannelMode::Ambient,
            Activeness::Low,
            &[],
            &s,
            &q,
        ));
        let high = sample(&run_with(
            &cfg,
            ChannelMode::Ambient,
            Activeness::High,
            &[],
            &s,
            &q,
        ));
        assert!((low - medium * 0.5).abs() < 1e-6);
        assert!((high - (medium * 1.6).min(1.0)).abs() < 1e-6);

        // Direct turns are not scaled.
        let named = vec![msg(ContextKind::Channel, "a", "小鯨魚早安")];
        let a = run_with(&cfg, ChannelMode::Ambient, Activeness::Low, &[], &s, &named);
        assert_eq!(a.gate, Gate::Sample(1.0));

        // She spoke 7s ago: inside the normal cooldown, outside the high one.
        let mut s = session_with(&q);
        let me = AccountRef {
            platform: PlatformId::new("t"),
            id: "her".into(),
        };
        let ago = Utc::now() - chrono::Duration::seconds(7);
        s.record_own("Her", me, "嗯", ActionId::new(), ago);
        s.record_message(&q[0], false);
        let a = run(&cfg, ChannelMode::Ambient, &s, &q);
        assert!(a.reasons.iter().any(|r| r.starts_with("cooldown")));
        let a = run_with(&cfg, ChannelMode::Ambient, Activeness::High, &[], &s, &q);
        assert!(!a.reasons.iter().any(|r| r.starts_with("cooldown")));
        assert!(matches!(a.gate, Gate::Sample(_)), "{a:?}");
    }

    #[test]
    fn sampling_is_seedable() {
        struct Fixed(f32);
        impl RandomSource for Fixed {
            fn next_f32(&self) -> f32 {
                self.0
            }
        }
        assert!(decide(0.5, &Fixed(0.4)).0);
        assert!(!decide(0.5, &Fixed(0.6)).0);
        assert!(decide(1.0, &Fixed(0.99)).0);
        assert!(!decide(0.0, &Fixed(0.0)).0);

        let (a, b) = (SeededRandom::new(7), SeededRandom::new(7));
        for _ in 0..100 {
            let x = a.next_f32();
            assert_eq!(x, b.next_f32());
            assert!((0.0..1.0).contains(&x));
        }
    }

    #[test]
    fn questions() {
        for q in ["真的嗎", "你在幹嘛?", "what is this", "這是什麼", "好吃吧~"] {
            assert!(is_question(q), "{q}");
        }
        for s in ["今天好熱", "哈哈哈", "好喔!"] {
            assert!(!is_question(s), "{s}");
        }
    }
}
