//! Voice Link protocol tests against a real server.

mod common;

use std::time::Duration;

use common::{Harness, SELF_ID, TOKEN, next_event, wait_until};
use futures::StreamExt;
use miyoria_speech::{AudioChunk, AudioStream};
use miyoria_types::{
    AccountRef, ContextKind, Event, ModuleId, ModuleStateKind, PlatformId, PlaybackState,
};
use miyoria_voice::AudioEvent;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

fn chunk(rate: u32, samples: Vec<i16>) -> anyhow::Result<AudioChunk> {
    Ok(AudioChunk {
        sample_rate: rate,
        samples,
    })
}

async fn recv_audio(rx: &mut tokio::sync::mpsc::Receiver<AudioEvent>) -> AudioEvent {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("audio event in time")
        .expect("channel open")
}

#[tokio::test]
async fn empty_token_fails_to_start() {
    let h = Harness::start(json!({ "token": "  " }), vec![]).await;
    let mut state = h.module_state("voice.link").await;
    for _ in 0..200 {
        if state.0 == ModuleStateKind::Failed {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        state = h.module_state("voice.link").await;
    }
    assert_eq!(state.0, ModuleStateKind::Failed);
    assert!(state.1.unwrap().contains("VOICE_LINK_TOKEN"));
    h.sup.stop_all().await;
}

#[tokio::test]
async fn hello_is_authenticated() {
    let h = Harness::start(json!({ "hello_timeout_ms": 300 }), vec![]).await;

    let mut wrong = h.connect().await;
    wrong.hello("nope", SELF_ID).await;
    assert_eq!(wrong.expect_close().await, 4401);

    let mut old = h.connect().await;
    old.send_json(json!({
        "type": "hello", "version": 2, "token": TOKEN,
        "self_account": { "platform": "discord", "id": SELF_ID }
    }))
    .await;
    assert_eq!(old.expect_close().await, 4400);

    let mut garbage = h.connect().await;
    garbage
        .send_json(json!({ "type": "joined", "guild": "g" }))
        .await;
    assert_eq!(garbage.expect_close().await, 4400);

    let mut silent = h.connect().await;
    assert_eq!(silent.expect_close().await, 4400, "no hello in time");

    assert!(!h.link().is_connected());

    let mut ready = h.subscribe(&["platform.ready"]);
    let _node = h.node(SELF_ID).await;
    let link = h.link();
    assert!(link.is_connected());
    let account = link.self_account().unwrap();
    assert_eq!(account.platform.as_str(), "discord");
    assert_eq!(account.id, SELF_ID);
    match &next_event(&mut ready).await.event {
        Event::PlatformReady {
            platform,
            self_account,
        } => {
            assert_eq!(platform.as_str(), "discord");
            assert_eq!(self_account, &account);
        }
        other => panic!("unexpected {other:?}"),
    }
    h.sup.stop_all().await;
}

#[tokio::test]
async fn join_voice_state_and_leave() {
    let h = Harness::start(json!({ "join_timeout_ms": 300 }), vec![]).await;
    // The bot account announces itself; it must count as her.
    let bot = AccountRef {
        platform: PlatformId::new("discord"),
        id: "99".into(),
    };
    let mut ready = h.subscribe(&["platform.ready"]);
    h.bus.publish(
        &ModuleId::from("platform.discord.bot"),
        Event::PlatformReady {
            platform: bot.platform.clone(),
            self_account: bot.clone(),
        },
        None,
    );
    next_event(&mut ready).await;
    let link = h.link();
    wait_until(|| link.is_self(&bot)).await;

    let mut node = h.node(SELF_ID).await;
    let mut events = h.subscribe(&["voice.*"]);

    let joining = {
        let link = link.clone();
        tokio::spawn(async move { link.join("g1", None, Some("u1")).await })
    };
    let join = node.recv_json().await;
    assert_eq!(
        join,
        json!({ "type": "join", "guild": "g1", "user_id": "u1" })
    );
    node.send_json(json!({
        "type": "voice_state", "guild": "g1", "channel": "vc1",
        "participants": [
            { "user_id": "u1", "display_name": "小明", "is_self": false, "muted": false, "deafened": false },
            { "user_id": SELF_ID, "display_name": "DeepSeek-chan", "is_self": true, "muted": false, "deafened": false },
            { "user_id": "99", "display_name": "bot", "is_self": false, "muted": true, "deafened": false }
        ]
    }))
    .await;
    node.send_json(json!({ "type": "joined", "guild": "g1", "channel": "vc1" }))
        .await;
    assert_eq!(joining.await.unwrap().unwrap(), "vc1");

    match &next_event(&mut events).await.event {
        Event::VoiceParticipants {
            context,
            participants,
        } => {
            assert_eq!(context.kind, ContextKind::Voice);
            assert_eq!(context.scope.as_deref(), Some("g1"));
            assert_eq!(context.channel, "vc1");
            let flags: Vec<_> = participants.iter().map(|p| p.is_self).collect();
            assert_eq!(flags, [false, true, true]);
            assert!(participants[2].muted);
        }
        other => panic!("unexpected {other:?}"),
    }
    match &next_event(&mut events).await.event {
        Event::VoiceJoined {
            context,
            participants,
        } => {
            assert_eq!(context.channel, "vc1");
            assert_eq!(participants.len(), 3);
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(link.channel("g1").as_deref(), Some("vc1"));
    assert_eq!(link.participants("g1")[0].display_name, "小明");

    node.send_json(json!({ "type": "speaking", "guild": "g1", "user_id": "u1", "speaking": true }))
        .await;
    match &next_event(&mut events).await.event {
        Event::VoiceSpeaking {
            context,
            account,
            speaking,
        } => {
            assert_eq!(context.channel, "vc1");
            assert_eq!(account.id, "u1");
            assert!(*speaking);
        }
        other => panic!("unexpected {other:?}"),
    }

    // A failing join resolves with the node's error.
    let failing = {
        let link = link.clone();
        tokio::spawn(async move { link.join("g2", Some("vc9"), None).await })
    };
    let join = node.recv_json().await;
    assert_eq!(
        join,
        json!({ "type": "join", "guild": "g2", "channel": "vc9" })
    );
    node.send_json(json!({ "type": "error", "message": "no permission to connect" }))
        .await;
    let err = failing.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("no permission"), "{err}");

    // No answer at all: times out.
    let err = link.join("g3", Some("vc3"), None).await.unwrap_err();
    assert!(err.to_string().contains("in time"), "{err}");
    node.recv_type("join").await;

    link.leave("g1").await.unwrap();
    assert_eq!(
        node.recv_json().await,
        json!({ "type": "leave", "guild": "g1" })
    );
    node.send_json(json!({ "type": "left", "guild": "g1", "reason": "leave" }))
        .await;
    match &next_event(&mut events).await.event {
        Event::VoiceLeft { context, reason } => {
            assert_eq!(context.channel, "vc1");
            assert_eq!(reason.as_deref(), Some("leave"));
        }
        other => panic!("unexpected {other:?}"),
    }
    assert!(link.channel("g1").is_none());
    assert!(link.participants("g1").is_empty());
    h.sup.stop_all().await;
}

#[tokio::test]
async fn captured_audio_becomes_audio_events() {
    let h = Harness::start(json!({}), vec![]).await;
    let mut node = h.node(SELF_ID).await;
    let mut audio = h.link().subscribe_audio();

    node.send_json(json!({
        "type": "stream_open", "stream": 5, "guild": "g1", "channel": "vc1",
        "user_id": "u1", "display_name": "小明", "sample_rate": 16000
    }))
    .await;
    // Frames of unknown streams are ignored.
    node.send_audio(77, &[9; 320]).await;
    let samples: Vec<i16> = (0..640).map(|i| i as i16).collect();
    node.send_audio(5, &samples).await;
    node.send_json(json!({ "type": "stream_close", "stream": 5 }))
        .await;

    let AudioEvent::StreamOpen(info) = recv_audio(&mut audio).await else {
        panic!("expected stream_open");
    };
    assert_eq!(info.speaker.id, "u1");
    assert_eq!(info.display_name, "小明");
    assert_eq!(info.sample_rate, 16_000);
    assert_eq!(info.context.scope.as_deref(), Some("g1"));
    assert_eq!(info.context.channel, "vc1");
    let mut got = Vec::new();
    loop {
        match recv_audio(&mut audio).await {
            AudioEvent::Frame { stream, samples } => {
                assert_eq!(stream, info.stream);
                got.extend(samples);
            }
            AudioEvent::StreamClose { stream } => {
                assert_eq!(stream, info.stream);
                break;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(got, samples);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn play_streams_audio_until_finished() {
    let h = Harness::start(json!({}), vec![]).await;
    let mut node = h.node(SELF_ID).await;
    let link = h.link();

    let audio: AudioStream = futures::stream::iter(vec![
        chunk(24_000, vec![1; 4000]),
        chunk(24_000, vec![2; 3000]),
    ])
    .boxed();
    let playback = link.play("g1", 24_000, audio).await.unwrap();
    let start = node.recv_json().await;
    assert_eq!(start["type"], "play_start");
    assert_eq!(start["guild"], "g1");
    assert_eq!(start["sample_rate"], 24_000);
    let id = u32::try_from(start["play"].as_u64().unwrap()).unwrap();
    assert_eq!(id, playback.id());

    let mut samples = 0;
    loop {
        match node.recv().await {
            Message::Binary(data) => {
                assert_eq!(data[0], 0x02);
                assert_eq!(u32::from_le_bytes(data[1..5].try_into().unwrap()), id);
                samples += (data.len() - 5) / 2;
            }
            Message::Text(text) => {
                let v: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
                assert_eq!(v, json!({ "type": "play_end", "play": id }));
                break;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(samples, 7000);
    assert_eq!(playback.state(), None);

    node.send_json(json!({ "type": "playback", "play": id, "state": "started" }))
        .await;
    wait_until(|| playback.state() == Some(PlaybackState::Started)).await;
    node.send_json(json!({ "type": "playback", "play": id, "state": "finished" }))
        .await;
    assert_eq!(playback.wait().await, PlaybackState::Finished);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn play_stop_interrupts() {
    let h = Harness::start(json!({}), vec![]).await;
    let mut node = h.node(SELF_ID).await;
    let link = h.link();

    // One chunk, then the TTS "keeps generating" forever.
    let audio: AudioStream = futures::stream::iter(vec![chunk(16_000, vec![3; 1600])])
        .chain(futures::stream::pending())
        .boxed();
    let playback = link.play("g1", 16_000, audio).await.unwrap();
    assert_eq!(node.recv_json().await["type"], "play_start");
    assert!(matches!(node.recv().await, Message::Binary(_)));
    playback.stop(80);
    let stop = node.recv_type("play_stop").await;
    assert_eq!(
        stop,
        json!({ "type": "play_stop", "play": playback.id(), "fade_ms": 80 })
    );
    assert_eq!(playback.wait().await, PlaybackState::Interrupted);

    // A stream error fails the playback.
    let broken: AudioStream =
        futures::stream::iter(vec![Err(anyhow::anyhow!("worker crashed"))]).boxed();
    let playback = link.play("g1", 16_000, broken).await.unwrap();
    assert_eq!(playback.wait().await, PlaybackState::Failed);
    h.sup.stop_all().await;
}

#[tokio::test]
async fn new_connection_replaces_old() {
    let h = Harness::start(json!({}), vec![]).await;
    let mut first = h.node(SELF_ID).await;
    let mut events = h.subscribe(&["voice.left"]);
    first
        .send_json(json!({ "type": "joined", "guild": "g1", "channel": "vc1" }))
        .await;
    let link = h.link();
    wait_until(|| link.channel("g1").is_some()).await;

    let mut audio = link.subscribe_audio();
    first
        .send_json(json!({
            "type": "stream_open", "stream": 1, "guild": "g1", "channel": "vc1",
            "user_id": "u1", "display_name": "", "sample_rate": 16000
        }))
        .await;
    assert!(matches!(
        recv_audio(&mut audio).await,
        AudioEvent::StreamOpen(_)
    ));

    let mut second = h.connect().await;
    second.hello(TOKEN, SELF_ID).await;
    assert_eq!(second.recv_json().await["type"], "welcome");
    assert_eq!(first.expect_close().await, 4409);
    // The old connection's streams are closed.
    assert!(matches!(
        recv_audio(&mut audio).await,
        AudioEvent::StreamClose { .. }
    ));

    // The new connection is the one in use.
    assert!(link.is_connected());
    link.leave("g1").await.unwrap();
    assert_eq!(second.recv_json().await["type"], "leave");
    // Replacement is not reported as leaving voice.
    assert!(
        tokio::time::timeout(Duration::from_millis(200), events.recv())
            .await
            .is_err()
    );
    h.sup.stop_all().await;
}

#[tokio::test]
async fn dead_peer_is_disconnected() {
    let h = Harness::start(
        json!({ "ping_interval_ms": 50, "peer_timeout_ms": 400 }),
        vec![],
    )
    .await;
    let link = h.link();

    // A node that answers pings stays connected well past the timeout.
    let mut alive = h.node("1").await;
    let mut events = h.subscribe(&["voice.left"]);
    alive
        .send_json(json!({ "type": "joined", "guild": "g1", "channel": "vc1" }))
        .await;
    let until = tokio::time::Instant::now() + Duration::from_millis(1000);
    while tokio::time::Instant::now() < until {
        let _ = tokio::time::timeout(Duration::from_millis(50), alive.recv()).await;
    }
    assert!(link.is_self(&AccountRef {
        platform: PlatformId::new("discord"),
        id: "1".into()
    }));
    assert!(link.is_connected());

    // Stop answering: Core gives up after the peer timeout.
    alive.auto_pong = false;
    let ping = alive.recv_json().await;
    assert_eq!(ping, json!({ "type": "ping" }));
    assert_eq!(alive.expect_close().await, 4408);
    wait_until(|| !link.is_connected()).await;
    match &next_event(&mut events).await.event {
        Event::VoiceLeft { context, reason } => {
            assert_eq!(context.channel, "vc1");
            assert_eq!(reason.as_deref(), Some("voice node disconnected"));
        }
        other => panic!("unexpected {other:?}"),
    }
    h.sup.stop_all().await;
}

#[tokio::test]
async fn ping_from_node_gets_pong() {
    let h = Harness::start(json!({}), vec![]).await;
    let mut node = h.node(SELF_ID).await;
    node.send_json(json!({ "type": "ping" })).await;
    assert_eq!(node.recv_json().await, json!({ "type": "pong" }));
    h.sup.stop_all().await;
}
