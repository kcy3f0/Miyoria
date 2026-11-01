//! `voice` module tests: listening, consent, speaking, barge-in and commands,
//! with a fake voice node and fake ASR / TTS providers.

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use common::{Harness, Node, SELF_ID, next_event};
use futures::StreamExt;
use miyoria_commands::{ArgValue, CommandRegistry, CommandsModule, Invocation};
use miyoria_kernel::{Module, ModuleContext, ModuleManifest, Subscription};
use miyoria_speech::{
    AsrHint, AsrProvider, AudioBuf, AudioChunk, AudioStream, SpeechService, Transcript,
    TtsProvider, TtsRequest,
};
use miyoria_store::{SettingsStore, Store};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, Event, ModuleId, PlatformId, PlaybackState, ProfileId,
    SpeakOutcome, VoiceSink,
};
use miyoria_voice::VoiceModule;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

const RATE: usize = 16_000;

/// 180 Hz voice-like tone, amplitude-modulated at 4 Hz.
fn voice(ms: usize) -> Vec<i16> {
    (0..RATE * ms / 1000)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let w = 2.0 * std::f32::consts::PI * 180.0 * t;
            let carrier = w.sin() * 0.6 + (2.0 * w).sin() * 0.3;
            let env = 0.55 + 0.45 * (2.0 * std::f32::consts::PI * 4.0 * t).sin();
            (carrier * env * 0.3 * 32767.0) as i16
        })
        .collect()
}

fn utterance_audio() -> Vec<i16> {
    let mut a = vec![0; RATE / 5];
    a.extend(voice(1200));
    a.extend(vec![0; RATE]);
    a
}

#[derive(Default)]
struct FakeAsr {
    text: Mutex<String>,
    calls: Mutex<Vec<(usize, AsrHint)>>,
}

#[async_trait]
impl AsrProvider for FakeAsr {
    fn name(&self) -> &str {
        "fake-asr"
    }

    async fn transcribe(&self, audio: &AudioBuf, hint: &AsrHint) -> anyhow::Result<Transcript> {
        assert_eq!(audio.sample_rate, 16_000);
        let text = self.text.lock().clone();
        self.calls.lock().push((audio.samples.len(), hint.clone()));
        Ok(Transcript {
            text,
            language: Some("zh".into()),
            emotion: Some("happy".into()),
            audio_events: vec!["laughter".into()],
        })
    }
}

#[derive(Default)]
struct FakeTts {
    requests: Mutex<Vec<TtsRequest>>,
    /// Keep the stream open after the audio (a long generation).
    endless: Mutex<bool>,
}

#[async_trait]
impl TtsProvider for FakeTts {
    fn name(&self) -> &str {
        "fake-tts"
    }

    async fn synthesize(&self, request: TtsRequest) -> anyhow::Result<AudioStream> {
        self.requests.lock().push(request);
        let chunks = vec![
            Ok(AudioChunk {
                sample_rate: 24_000,
                samples: Vec::new(),
            }),
            Ok(AudioChunk {
                sample_rate: 24_000,
                samples: vec![100; 2400],
            }),
            Ok(AudioChunk {
                sample_rate: 24_000,
                samples: vec![-100; 2400],
            }),
        ];
        let stream = futures::stream::iter(chunks);
        Ok(if *self.endless.lock() {
            stream.chain(futures::stream::pending()).boxed()
        } else {
            stream.boxed()
        })
    }
}

/// Stands in for the `speech` module.
struct FakeSpeech {
    manifest: ModuleManifest,
    asr: Arc<FakeAsr>,
    tts: Arc<FakeTts>,
}

#[async_trait]
impl Module for FakeSpeech {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        ctx.provide(Arc::new(SpeechService::new(
            vec![self.asr.clone()],
            vec![self.tts.clone()],
        )));
        Ok(())
    }
}

struct Env {
    h: Harness,
    asr: Arc<FakeAsr>,
    tts: Arc<FakeTts>,
    settings: Arc<dyn SettingsStore>,
    node: Node,
}

fn deepseek_voice() -> toml::Table {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../profiles/deepseek-chan/voice.toml"
    );
    toml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

async fn boot(voice_config: Value) -> Env {
    let asr = Arc::new(FakeAsr::default());
    *asr.text.lock() = "这个游戏好难".into();
    let tts = Arc::new(FakeTts::default());
    let settings = Store::memory().settings;
    let speech: Arc<dyn Module> = Arc::new(FakeSpeech {
        manifest: ModuleManifest::new("speech", "Fake speech"),
        asr: asr.clone(),
        tts: tts.clone(),
    });
    let voice: Arc<dyn Module> = Arc::new(VoiceModule::new(
        ProfileId::from("deepseek-chan"),
        Some(deepseek_voice()),
    ));
    let store = settings.clone();
    let h = Harness::start_with(
        json!({}),
        vec![
            (speech, Value::Null),
            (Arc::new(CommandsModule::new()), Value::Null),
            (voice, voice_config),
        ],
        move |services| services.provide::<dyn SettingsStore>(&ModuleId::from("app"), store),
    )
    .await;
    let mut node = h.node(SELF_ID).await;
    node.send_json(json!({
        "type": "voice_state", "guild": "g1", "channel": "vc1",
        "participants": [
            { "user_id": "u1", "display_name": "小明" },
            { "user_id": "u2", "display_name": "阿華" },
            { "user_id": SELF_ID, "display_name": "DeepSeek-chan", "is_self": true }
        ]
    }))
    .await;
    node.send_json(json!({ "type": "joined", "guild": "g1", "channel": "vc1" }))
        .await;
    let link = h.link();
    common::wait_until(|| link.participants("g1").len() == 3).await;
    Env {
        h,
        asr,
        tts,
        settings,
        node,
    }
}

fn voice_ctx() -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some("g1".into()),
        channel: "vc1".into(),
        kind: ContextKind::Voice,
    }
}

fn account(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: id.to_owned(),
    }
}

impl Env {
    async fn speak_stream(&mut self, stream: u32, user: &str, audio: &[i16]) {
        self.node
            .send_json(json!({
                "type": "stream_open", "stream": stream, "guild": "g1", "channel": "vc1",
                "user_id": user, "display_name": format!("nick-{user}"), "sample_rate": 16000
            }))
            .await;
        self.node.send_audio(stream, audio).await;
        self.node
            .send_json(json!({ "type": "stream_close", "stream": stream }))
            .await;
    }

    fn registry(&self) -> Arc<CommandRegistry> {
        self.h.services.require::<CommandRegistry>().unwrap()
    }

    async fn command(&self, path: &str, invoker: &str, args: &[(&str, &str)]) -> String {
        let inv = Invocation {
            path: path.split_whitespace().map(str::to_owned).collect(),
            args: args
                .iter()
                .map(|(k, v)| ((*k).to_owned(), ArgValue::String((*v).to_owned())))
                .collect::<BTreeMap<_, _>>(),
            invoker: account(invoker),
            invoker_display_name: invoker.to_owned(),
            context: ContextKey {
                platform: PlatformId::new("discord"),
                scope: Some("g1".into()),
                channel: "text1".into(),
                kind: ContextKind::Channel,
            },
            invoker_is_guild_admin: false,
        };
        self.registry().dispatch(inv).await.unwrap().text
    }
}

async fn next_utterance(sub: &mut Subscription) -> miyoria_types::VoiceUtterance {
    loop {
        if let Event::VoiceUtterance(u) = &next_event(sub).await.event {
            return u.clone();
        }
    }
}

#[tokio::test]
async fn transcribes_utterances() {
    let mut env = boot(json!({ "asr_prompt": "DeepSeek醬" })).await;
    let mut events = env.h.subscribe(&["voice.utterance", "voice.latency"]);
    env.speak_stream(1, "u1", &utterance_audio()).await;

    let u = next_utterance(&mut events).await;
    assert_eq!(u.text, "這個遊戲好難");
    assert_eq!(u.speaker.account, account("u1"));
    assert_eq!(u.speaker.display_name, "小明", "name from participants");
    assert_eq!(u.context, voice_ctx());
    assert_eq!(u.language.as_deref(), Some("zh"));
    assert_eq!(u.emotion.as_deref(), Some("happy"));
    assert_eq!(u.audio_events, ["laughter"]);
    assert!(u.ended_at > u.started_at);
    let latency = next_event(&mut events).await;
    match &latency.event {
        Event::Custom { topic, payload } => {
            assert_eq!(topic, "voice.latency");
            assert_eq!(payload["stage"], "asr");
            assert_eq!(payload["provider"], "fake-asr");
            assert!(payload["asr_ms"].as_u64().is_some());
        }
        other => panic!("unexpected {other:?}"),
    }
    let calls = env.asr.calls.lock().clone();
    assert_eq!(calls.len(), 1);
    // About 0.2 s pre-roll + 1.2 s speech + 0.2 s tail.
    assert!((RATE..RATE * 2).contains(&calls[0].0), "{}", calls[0].0);
    assert_eq!(calls[0].1.prompt.as_deref(), Some("DeepSeek醬"));
    assert_eq!(calls[0].1.language, None);

    // Hallucinations and silence produce nothing.
    *env.asr.text.lock() = "谢谢观看".into();
    env.speak_stream(2, "u1", &utterance_audio()).await;
    env.speak_stream(3, "u1", &vec![0; RATE * 2]).await;
    let asr = env.asr.clone();
    common::wait_until(|| asr.calls.lock().len() == 2).await;
    *env.asr.text.lock() = "最后一句".into();
    env.speak_stream(4, "u1", &utterance_audio()).await;
    assert_eq!(next_utterance(&mut events).await.text, "最後一句");
    assert_eq!(env.asr.calls.lock().len(), 3, "silence never reaches ASR");
    env.h.sup.stop_all().await;
}

#[tokio::test]
async fn consent_is_respected() {
    let mut env = boot(json!({})).await;
    let mut events = env.h.subscribe(&["voice.utterance"]);

    let reply = env
        .command("voice consent", "u2", &[("state", "off")])
        .await;
    assert!(reply.contains("不會聽"), "{reply}");
    let stored = env
        .settings
        .get(&ProfileId::from("_global"), "voice_consent:discord:u2")
        .await
        .unwrap();
    assert_eq!(stored, Some(Value::Bool(false)));

    env.speak_stream(1, "u2", &utterance_audio()).await;
    env.speak_stream(2, "u1", &utterance_audio()).await;
    let u = next_utterance(&mut events).await;
    assert_eq!(u.speaker.account.id, "u1");
    assert_eq!(env.asr.calls.lock().len(), 1, "u2 never reached ASR");

    // Her own account is never transcribed either.
    env.speak_stream(3, SELF_ID, &utterance_audio()).await;
    env.command("voice consent", "u2", &[("state", "on")]).await;
    env.speak_stream(4, "u2", &utterance_audio()).await;
    assert_eq!(next_utterance(&mut events).await.speaker.account.id, "u2");
    assert_eq!(env.asr.calls.lock().len(), 2);
    env.h.sup.stop_all().await;
}

#[tokio::test]
async fn opt_in_policy_drops_unknown_users() {
    let mut env = boot(json!({ "consent": "opt-in", "to_traditional": false })).await;
    let mut events = env.h.subscribe(&["voice.utterance"]);
    env.speak_stream(1, "u1", &utterance_audio()).await;
    env.command("voice consent", "u2", &[("state", "on")]).await;
    env.speak_stream(2, "u2", &utterance_audio()).await;
    let u = next_utterance(&mut events).await;
    assert_eq!(u.speaker.account.id, "u2");
    assert_eq!(u.text, "这个游戏好难", "conversion disabled");
    assert_eq!(env.asr.calls.lock().len(), 1);
    env.h.sup.stop_all().await;
}

async fn read_playback(node: &mut Node) -> (u32, u32, usize) {
    let start = node.recv_type("play_start").await;
    let id = u32::try_from(start["play"].as_u64().unwrap()).unwrap();
    let rate = u32::try_from(start["sample_rate"].as_u64().unwrap()).unwrap();
    let mut samples = 0;
    loop {
        match node.recv().await {
            Message::Binary(data) => samples += (data.len() - 5) / 2,
            Message::Text(t) if t.as_str().contains("play_end") => return (id, rate, samples),
            other => panic!("unexpected {other:?}"),
        }
    }
}

#[tokio::test]
async fn speaks_through_tts() {
    let mut env = boot(json!({})).await;
    let mut events = env.h.subscribe(&["voice.playback", "voice.latency"]);
    let sink = env.h.services.require::<dyn VoiceSink>().unwrap();
    let speaking = tokio::spawn(async move {
        sink.speak(
            &voice_ctx(),
            "<emo:annoyed>哼,才不是在等你呢。<pause 300/>",
            Some("annoyed"),
            None,
        )
        .await
    });
    let (id, rate, samples) = read_playback(&mut env.node).await;
    assert_eq!((rate, samples), (24_000, 4800));
    env.node
        .send_json(json!({ "type": "playback", "play": id, "state": "started" }))
        .await;
    env.node
        .send_json(json!({ "type": "playback", "play": id, "state": "finished" }))
        .await;
    assert_eq!(speaking.await.unwrap().unwrap(), SpeakOutcome::Completed);

    let req = env.tts.requests.lock()[0].clone();
    assert_eq!(req.text, "哼,才不是在等你呢。");
    assert_eq!(req.language.as_deref(), Some("Chinese"));
    assert_eq!(req.emotion.as_deref(), Some("annoyed"));
    assert_eq!(req.instruct.as_deref(), Some("不耐煩、拖長音"));
    assert_eq!(req.voice.as_deref(), Some("deepseek-chan"));

    let mut states = Vec::new();
    let mut first_audio = None;
    while states.len() < 2 {
        match &next_event(&mut events).await.event {
            Event::VoicePlayback { state, text, .. } => {
                assert_eq!(text, "哼,才不是在等你呢。");
                states.push(*state);
            }
            Event::Custom { payload, .. } => {
                assert_eq!(payload["stage"], "tts");
                first_audio = payload["first_audio_ms"].as_u64();
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(states, [PlaybackState::Started, PlaybackState::Finished]);
    assert!(first_audio.is_some());

    // Nothing left after stripping tags: nothing to say.
    let sink = env.h.services.require::<dyn VoiceSink>().unwrap();
    assert_eq!(
        sink.speak(&voice_ctx(), "<silence/>", None, None)
            .await
            .unwrap(),
        SpeakOutcome::Completed
    );
    assert_eq!(env.tts.requests.lock().len(), 1);
    env.h.sup.stop_all().await;
}

#[tokio::test]
async fn barge_in_stops_playback() {
    let mut env = boot(json!({})).await;
    *env.tts.endless.lock() = true;
    let mut events = env.h.subscribe(&["voice.playback"]);
    let sink = env.h.services.require::<dyn VoiceSink>().unwrap();
    let speaking =
        tokio::spawn(async move { sink.speak(&voice_ctx(), "我跟你說喔", None, None).await });
    let start = env.node.recv_type("play_start").await;
    let id = start["play"].as_u64().unwrap();
    match &next_event(&mut events).await.event {
        Event::VoicePlayback { state, .. } => assert_eq!(*state, PlaybackState::Started),
        other => panic!("unexpected {other:?}"),
    }

    // A short "嗯" does not interrupt her; talking over her does.
    env.node
        .send_json(json!({
            "type": "stream_open", "stream": 9, "guild": "g1", "channel": "vc1",
            "user_id": "u1", "display_name": "", "sample_rate": 16000
        }))
        .await;
    env.node.send_audio(9, &voice(300)).await;
    env.node.send_audio(9, &vec![0; RATE / 2]).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!speaking.is_finished());
    env.node.send_audio(9, &voice(1000)).await;

    let stop = env.node.recv_type("play_stop").await;
    assert_eq!(
        stop,
        json!({ "type": "play_stop", "play": id, "fade_ms": 150 })
    );
    assert_eq!(speaking.await.unwrap().unwrap(), SpeakOutcome::Interrupted);
    match &next_event(&mut events).await.event {
        Event::VoicePlayback { state, .. } => assert_eq!(*state, PlaybackState::Interrupted),
        other => panic!("unexpected {other:?}"),
    }
    env.h.sup.stop_all().await;
}

#[tokio::test]
async fn barge_in_can_be_ignored() {
    let mut env = boot(json!({ "barge_in": "ignore" })).await;
    let sink = env.h.services.require::<dyn VoiceSink>().unwrap();
    let speaking =
        tokio::spawn(async move { sink.speak(&voice_ctx(), "我跟你說喔", None, None).await });
    let (id, _, _) = read_playback(&mut env.node).await;
    env.speak_stream(9, "u1", &utterance_audio()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!speaking.is_finished());
    env.node
        .send_json(json!({ "type": "playback", "play": id, "state": "finished" }))
        .await;
    assert_eq!(speaking.await.unwrap().unwrap(), SpeakOutcome::Completed);
    env.h.sup.stop_all().await;
}

#[tokio::test]
async fn join_and_leave_commands() {
    let mut env = boot(json!({})).await;
    let registry = env.registry();
    assert!(registry.get(&["join".to_owned()]).is_some());
    assert_eq!(
        registry.group_description(&["voice".to_owned()]).as_deref(),
        Some("語音設定")
    );

    let joining = {
        let registry = registry.clone();
        tokio::spawn(async move {
            let inv = Invocation {
                path: vec!["join".into()],
                args: BTreeMap::new(),
                invoker: account("u7"),
                invoker_display_name: "u7".into(),
                context: ContextKey {
                    platform: PlatformId::new("discord"),
                    scope: Some("g2".into()),
                    channel: "text1".into(),
                    kind: ContextKind::Channel,
                },
                invoker_is_guild_admin: false,
            };
            registry.dispatch(inv).await.unwrap()
        })
    };
    let join = env.node.recv_type("join").await;
    assert_eq!(
        join,
        json!({ "type": "join", "guild": "g2", "user_id": "u7" })
    );
    env.node
        .send_json(json!({ "type": "joined", "guild": "g2", "channel": "vc2" }))
        .await;
    let reply = joining.await.unwrap();
    assert!(!reply.ephemeral);
    assert!(reply.text.contains("/voice consent off"), "{}", reply.text);

    let reply = env.command("leave", "u7", &[]).await;
    assert!(reply.contains("我走"), "{reply}");
    assert_eq!(env.node.recv_type("leave").await["guild"], "g1");

    // Stopping the module removes its commands.
    env.h.sup.disable(&ModuleId::from("voice")).await.unwrap();
    assert!(registry.get(&["join".to_owned()]).is_none());
    assert!(
        registry
            .get(&["voice".to_owned(), "consent".to_owned()])
            .is_none()
    );
    env.h.sup.stop_all().await;
}
