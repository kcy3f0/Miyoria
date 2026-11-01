//! Voice conversation: utterances in, `Speak` actions out. Playback events
//! that the voice module would publish are simulated by the tests.

use miyoria_types::{PlaybackState, VoiceParticipant, VoiceUtterance};

use super::*;

fn voice_ctx() -> ContextKey {
    ContextKey {
        platform: PlatformId::new("test"),
        scope: Some("guild".into()),
        channel: "vc".into(),
        kind: ContextKind::Voice,
    }
}

/// No LLM check, no cooldown; `mode` is the voice default mode.
fn voice_config(mode: &str) -> serde_json::Value {
    serde_json::json!({
        "attention": { "llm_check": false },
        "voice": { "default_mode": mode, "cooldown_ms": 0 }
    })
}

fn member(id: &str, is_self: bool) -> VoiceParticipant {
    VoiceParticipant {
        account: account(id),
        display_name: id.into(),
        is_self,
        muted: false,
        deafened: false,
    }
}

fn joined() -> Event {
    Event::VoiceJoined {
        context: voice_ctx(),
        participants: vec![
            member("Owen", false),
            member("阿明", false),
            member("her", true),
        ],
    }
}

fn utterance(who: &str, text: &str) -> Event {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    let now = chrono::Utc::now() + chrono::Duration::microseconds(n as i64);
    Event::VoiceUtterance(VoiceUtterance {
        id: format!("u{n}"),
        context: voice_ctx(),
        speaker: Author {
            account: account(who),
            display_name: who.into(),
            is_bot: false,
        },
        text: text.into(),
        language: Some("zh".into()),
        emotion: None,
        audio_events: Vec::new(),
        started_at: now - chrono::Duration::seconds(1),
        ended_at: now,
        asr_ms: 200,
    })
}

fn speaking(who: &str, on: bool) -> Event {
    Event::VoiceSpeaking {
        context: voice_ctx(),
        account: account(who),
        speaking: on,
    }
}

fn playback(turn: TurnId, state: PlaybackState, text: &str) -> Event {
    Event::VoicePlayback {
        context: voice_ctx(),
        turn: Some(turn),
        state,
        text: text.into(),
    }
}

/// `(text, emotion)` of every `Speak` action, in submission order.
fn speeches(sink: &FakeSink) -> Vec<(String, Option<String>)> {
    speak_actions(sink)
        .into_iter()
        .filter_map(|a| match a.payload {
            ActionPayload::Speak { text, emotion, .. } => Some((text, emotion)),
            _ => None,
        })
        .collect()
}

fn speak_actions(sink: &FakeSink) -> Vec<Action> {
    sink.actions
        .lock()
        .iter()
        .filter(|a| matches!(a.payload, ActionPayload::Speak { .. }))
        .cloned()
        .collect()
}

fn texts(sink: &FakeSink) -> Vec<String> {
    speeches(sink).into_iter().map(|(t, _)| t).collect()
}

/// Reasons of every decision published so far.
fn decision_reasons(h: &mut Harness) -> Vec<(bool, Vec<String>)> {
    h.drain()
        .iter()
        .filter_map(|e| match &e.event {
            Event::AgentDecision(d) => Some((d.respond, d.reasons.clone())),
            _ => None,
        })
        .collect()
}

/// Streams `(delay_ms, event)` pairs, each after its delay.
struct Paced {
    script: Mutex<Vec<Vec<(u64, StreamEvent)>>>,
    requests: Mutex<Vec<ChatRequest>>,
}

impl Paced {
    fn new(replies: Vec<Vec<(u64, StreamEvent)>>) -> Self {
        Self {
            script: Mutex::new(replies),
            requests: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl ChatProvider for Paced {
    fn name(&self) -> &str {
        "paced"
    }

    async fn stream(&self, request: ChatRequest) -> anyhow::Result<ChatStream> {
        self.requests.lock().push(request);
        let mut script = self.script.lock();
        let events = if script.len() > 1 {
            script.remove(0)
        } else {
            script[0].clone()
        };
        Ok(futures::stream::iter(events)
            .then(|(delay, event)| async move {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                Ok(event)
            })
            .boxed())
    }
}

fn text(s: &str) -> StreamEvent {
    StreamEvent::TextDelta(s.to_owned())
}

#[tokio::test(start_paused = true)]
async fn utterances_are_debounced_and_merged() {
    let mock = Arc::new(MockProvider::new("chat").reply("<emo:happy>考完啦?辛苦了。"));
    let mut h = Harness::new("off", voice_config("always"), mock.clone(), None).await;
    h.publish(joined());
    h.publish(utterance("Owen", "我跟你說"));
    wait(400).await;
    h.publish(utterance("Owen", "今天考試考完了"));
    wait(500).await;
    assert!(mock.requests().is_empty(), "the speaker may continue");
    wait(400).await;

    let requests = mock.requests();
    assert_eq!(requests.len(), 1);
    let msgs = &requests[0].messages;
    assert_eq!(msgs.len(), 3);
    assert_eq!(
        msgs[1].content,
        "Owen(語音): 我跟你說\nOwen(語音): 今天考試考完了"
    );
    let situation = &msgs[2].content;
    assert!(
        situation.contains("語音頻道裡的人:Owen、阿明"),
        "{situation}"
    );
    assert!(situation.contains("一到兩句"), "{situation}");
    assert!(requests[0].tools.is_empty(), "no `react` in voice");

    assert_eq!(
        speeches(&h.sink),
        [
            ("考完啦?".to_owned(), Some("happy".to_owned())),
            ("辛苦了。".to_owned(), Some("happy".to_owned())),
        ]
    );
    let actions = speak_actions(&h.sink);
    assert!(
        actions
            .iter()
            .all(|a| a.lane.as_str() == "voice:test:guild")
    );
    assert!(actions.iter().all(|a| a.priority == Priority::Initiative));
    assert!(actions.iter().all(|a| a.turn.is_some()));
    assert!(h.sink.texts().is_empty() && h.sink.typing() == 0);
    let completed: Vec<String> = h
        .drain()
        .iter()
        .filter_map(|e| match &e.event {
            Event::AgentTurnCompleted { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(completed, ["考完啦?辛苦了。"]);
}

#[tokio::test(start_paused = true)]
async fn no_reply_while_someone_is_speaking() {
    let mock = Arc::new(MockProvider::new("chat").reply("我看過喔。"));
    let mut h = Harness::new("off", voice_config("ambient"), mock.clone(), None).await;
    h.publish(joined());

    // Speaking extends the debounce: the turn waits for the transcript.
    h.publish(utterance("Owen", "你們看過鯨魚嗎?"));
    wait(300).await;
    h.publish(speaking("阿明", true));
    wait(900).await;
    h.publish(speaking("阿明", false));
    wait(500).await;
    assert!(
        decision_reasons(&mut h).is_empty(),
        "turn started too early"
    );
    wait(300).await;
    let decisions = decision_reasons(&mut h);
    assert_eq!(decisions.len(), 1);
    assert!(decisions[0].0, "{:?}", decisions[0].1);
    assert_eq!(texts(&h.sink), ["我看過喔。"]);

    // Someone keeps talking: at the cap she still does not join in.
    h.publish(speaking("阿明", true));
    h.publish(utterance("Owen", "那海豚呢?"));
    wait(2000).await;
    assert!(decision_reasons(&mut h).is_empty());
    wait(600).await;
    let decisions = decision_reasons(&mut h);
    assert_eq!(decisions.len(), 1);
    assert!(!decisions[0].0);
    assert!(
        decisions[0].1.iter().any(|r| r == "someone is speaking"),
        "{:?}",
        decisions[0].1
    );
    assert_eq!(mock.requests().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn direct_address_by_nickname_in_transcript() {
    let mock = Arc::new(MockProvider::new("chat").reply("幹嘛啦。"));
    let mut h = Harness::new("always", voice_config("mention-only"), mock.clone(), None).await;
    h.publish(joined());
    for (who, said) in [
        ("Owen", "今天好熱"),
        ("阿明", "小鯨魚妳覺得呢"),
        ("Owen", "deep seek 在嗎"),
    ] {
        h.publish(utterance(who, said));
        wait(3000).await;
    }
    assert_eq!(h.decisions(), [false, true, true]);
    let actions = speak_actions(&h.sink);
    assert_eq!(actions.len(), 2);
    assert!(actions.iter().all(|a| a.priority == Priority::Direct));

    // A question right after she spoke is for her too.
    let turn = actions[1].turn.unwrap();
    h.publish(playback(turn, PlaybackState::Started, "幹嘛啦。"));
    h.publish(playback(turn, PlaybackState::Finished, "幹嘛啦。"));
    h.publish(utterance("Owen", "妳在幹嘛?"));
    wait(3000).await;
    assert_eq!(h.decisions(), [true]);
    let last = mock.requests().pop().unwrap();
    assert_eq!(last.messages[last.messages.len() - 3].content, "幹嘛啦。");
}

#[tokio::test(start_paused = true)]
async fn sentences_are_spoken_while_the_model_still_streams() {
    let paced = Arc::new(Paced::new(vec![vec![
        (0, text("<emo:smug>哼,才不是在等你呢。")),
        (1000, text("你回來啦?<emo:happy>")),
        (1000, text("好啦好啦。")),
        (5000, done()),
    ]]));
    let mut h = Harness::new("off", voice_config("always"), paced.clone(), None).await;
    h.publish(joined());
    h.publish(utterance("Owen", "我回來了"));
    // The turn starts at 0.7s; chunks at 0.7s, 1.7s and 2.7s; done at 7.7s.
    wait(1200).await;
    assert!(speeches(&h.sink).is_empty(), "the end mark may continue");
    wait(1000).await;
    assert_eq!(
        speeches(&h.sink),
        [
            ("哼,才不是在等你呢。".to_owned(), Some("smug".to_owned())),
            ("你回來啦?".to_owned(), Some("smug".to_owned())),
        ]
    );
    wait(1000).await;
    assert_eq!(
        speeches(&h.sink).len(),
        2,
        "held until more text or the end"
    );
    assert!(
        !h.drain()
            .iter()
            .any(|e| e.topic() == "agent.turn.completed")
    );
    wait(5000).await;
    let all = speeches(&h.sink);
    assert_eq!(all.len(), 3);
    assert_eq!(all[2], ("好啦好啦。".to_owned(), Some("happy".to_owned())));
    let turns: Vec<_> = speak_actions(&h.sink).iter().map(|a| a.turn).collect();
    assert!(turns.iter().all(|t| *t == turns[0]));
}

#[tokio::test(start_paused = true)]
async fn silence_and_unspeakable_replies_say_nothing() {
    let mock = Arc::new(
        MockProvider::new("chat")
            .reply("<silence/>")
            .reply("<emo:sad>……")
            .reply("DeepSeek-chan: 好啦。"),
    );
    let mut h = Harness::new("off", voice_config("always"), mock.clone(), None).await;
    h.publish(joined());
    for said in ["一", "二", "三"] {
        h.publish(utterance("Owen", said));
        wait(3000).await;
    }
    assert_eq!(mock.requests().len(), 3);
    assert_eq!(texts(&h.sink), ["好啦。"]);
    let completed: Vec<String> = h
        .drain()
        .iter()
        .filter_map(|e| match &e.event {
            Event::AgentTurnCompleted { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(completed, ["", "", "好啦。"]);
}

#[tokio::test(start_paused = true)]
async fn utterance_before_playback_cancels_and_regenerates() {
    let mock = Arc::new(
        MockProvider::new("chat")
            .reply("第一個回答。")
            .reply("第二個回答。")
            .reply("第三個回答。"),
    );
    let mut h = Harness::new("off", voice_config("always"), mock.clone(), None).await;
    h.publish(joined());
    h.publish(utterance("Owen", "一"));
    wait(2000).await;
    let first = speak_actions(&h.sink)[0].turn.unwrap();
    // Her answer is queued but has not started playing yet.
    h.publish(utterance("Owen", "二"));
    wait(2000).await;
    assert_eq!(*h.sink.cancelled.lock(), [first]);
    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].messages[1].content,
        "Owen(語音): 一\nOwen(語音): 二"
    );

    // Once playback started, new input waits for a turn of its own.
    let second = speak_actions(&h.sink)[1].turn.unwrap();
    assert_ne!(first, second);
    h.publish(playback(second, PlaybackState::Started, "第二個回答。"));
    wait(100).await;
    h.publish(utterance("Owen", "三"));
    wait(2000).await;
    assert_eq!(*h.sink.cancelled.lock(), [first]);
    let requests = mock.requests();
    assert_eq!(requests.len(), 3);
    let history: Vec<(ChatRole, &str)> = requests[2].messages[1..requests[2].messages.len() - 1]
        .iter()
        .map(|m| (m.role, m.content.as_str()))
        .collect();
    assert_eq!(
        history,
        [
            (ChatRole::User, "Owen(語音): 一\nOwen(語音): 二"),
            (ChatRole::Assistant, "第二個回答。"),
            (ChatRole::User, "Owen(語音): 三"),
        ]
    );
    let _ = h.drain();
}

#[tokio::test(start_paused = true)]
async fn interrupted_playback_stops_further_sentences() {
    let paced = Arc::new(Paced::new(vec![
        vec![
            (0, text("第一句。")),
            (1000, text("第二句。")),
            (1000, text("第三句。")),
            (1000, text("第四句。")),
            (0, done()),
        ],
        vec![(0, text("好啦。")), (0, done())],
    ]));
    let h = Harness::new("off", voice_config("always"), paced.clone(), None).await;
    h.publish(joined());
    h.publish(utterance("Owen", "講個故事"));
    // Turn at 0.7s; "第一句。" is complete when the second chunk arrives (1.7s).
    wait(1900).await;
    assert_eq!(texts(&h.sink), ["第一句。"]);
    let turn = speak_actions(&h.sink)[0].turn.unwrap();
    h.publish(playback(turn, PlaybackState::Started, "第一句。"));
    h.publish(playback(turn, PlaybackState::Interrupted, "第一句。"));
    wait(5000).await;
    assert_eq!(texts(&h.sink), ["第一句。"]);
    assert_eq!(*h.sink.cancelled.lock(), [turn]);

    // She knows she was cut off.
    h.publish(utterance("Owen", "抱歉妳繼續"));
    wait(2000).await;
    let requests = paced.requests.lock();
    assert_eq!(requests.len(), 2);
    let msgs = &requests[1].messages;
    assert_eq!(msgs[2].role, ChatRole::Assistant);
    assert_eq!(msgs[2].content, "第一句。(被打斷)");
    assert_eq!(texts(&h.sink), ["第一句。", "好啦。"]);
}

#[tokio::test(start_paused = true)]
async fn leaving_voice_clears_the_session() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯。"));
    let h = Harness::new("off", voice_config("always"), mock.clone(), None).await;
    h.publish(joined());
    h.publish(utterance("Owen", "舊的話"));
    wait(2000).await;
    h.publish(Event::VoiceLeft {
        context: voice_ctx(),
        reason: None,
    });
    wait(10).await;
    assert_eq!(
        h.handle().voice_context(&PlatformId::new("test"), "guild"),
        None
    );
    h.publish(joined());
    h.publish(utterance("Owen", "新的話"));
    wait(2000).await;
    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].messages[1].content, "Owen(語音): 新的話");
}

#[tokio::test(start_paused = true)]
async fn voice_mode_command() {
    let mock = Arc::new(MockProvider::new("chat").reply("嗯。"));
    let mut h = Harness::build(
        "ambient",
        voice_config("ambient"),
        mock.clone(),
        None,
        Setup {
            owners: Some(vec!["test:Owen"]),
            ..Default::default()
        },
    )
    .await;
    let reg = h.sup.services().require::<CommandRegistry>().unwrap();
    let handle = h.handle();
    let run = |inv: Invocation| {
        let reg = reg.clone();
        async move { reg.dispatch(inv).await.unwrap() }
    };
    // Sent from a text channel of the guild.
    let not_in = run(command("voice mode", "Owen", &[])).await;
    assert!(
        not_in.ephemeral && not_in.text.contains("語音"),
        "{}",
        not_in.text
    );

    h.publish(joined());
    wait(10).await;
    let shown = run(command("voice mode", "Owen", &[])).await;
    assert!(
        shown.text.contains("`ambient`") && shown.text.contains("預設"),
        "{}",
        shown.text
    );

    let denied = run(command("voice mode", "阿明", &[("mode", "off")])).await;
    assert!(denied.text.contains("權限"), "{}", denied.text);

    run(command("voice mode", "Owen", &[("mode", "mention-only")])).await;
    let v = voice_ctx();
    assert_eq!(handle.channel_mode(&v), ChannelMode::MentionOnly);
    assert_eq!(handle.channel_mode(&channel("c")), ChannelMode::Ambient);
    // The mode applies to the voice context.
    h.publish(utterance("Owen", "你們看過鯨魚嗎?"));
    wait(3000).await;
    assert_eq!(h.decisions(), [false]);

    let reset = run(command("voice mode", "Owen", &[("mode", "reset")])).await;
    assert!(reset.text.contains("`ambient`"), "{}", reset.text);
    assert_eq!(handle.channel_mode_override(&v), None);

    h.publish(Event::VoiceLeft {
        context: v,
        reason: Some("kicked".into()),
    });
    wait(10).await;
    assert!(run(command("voice mode", "Owen", &[])).await.ephemeral);
}
