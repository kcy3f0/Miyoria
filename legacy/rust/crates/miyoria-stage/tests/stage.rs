//! End to end: `stage.link` on Core ↔ the Stage runtime, with a fake VTube
//! Studio and a fake OBS. Plus the levels and overlay endpoints.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{FakeObs, FakeVts, WAIT, temp_dir, wait_until};
use futures::{SinkExt, StreamExt};
use miyoria_kernel::{EventBus, ServiceRegistry, Supervisor};
use miyoria_stage::link::EMOTION_TOPIC;
use miyoria_stage::lipsync::{Levels, LipSyncConfig, serve_levels};
use miyoria_stage::overlay::{OverlayHub, serve_overlay};
use miyoria_stage::protocol::StageStatus;
use miyoria_stage::{
    AvatarAction, AvatarProfile, StageConfig, StageLink, StageLinkModule, StreamAction,
    run_stage_with,
};
use miyoria_types::{ContextKey, ContextKind, Event, ModuleId, PlatformId, PlaybackState, TurnId};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

const TOKEN: &str = "stage-secret";

async fn core() -> (
    Supervisor,
    Arc<ServiceRegistry>,
    EventBus,
    Arc<StageLinkModule>,
) {
    let services = Arc::new(ServiceRegistry::new());
    let bus = EventBus::default();
    let sup = Supervisor::new(bus.clone(), services.clone());
    let module = Arc::new(StageLinkModule::new());
    sup.register(
        module.clone(),
        json!({ "bind": "127.0.0.1:0", "token": TOKEN }),
        true,
    )
    .await;
    sup.start_all().await.unwrap();
    (sup, services, bus, module)
}

fn stage_config(core: &StageLinkModule, vts: &FakeVts) -> StageConfig {
    let mut c = StageConfig {
        core_url: format!("ws://{}/stage-link", core.local_addr().unwrap()),
        token: TOKEN.into(),
        data_dir: temp_dir(),
        overlay_bind: "127.0.0.1:0".into(),
        overlay_dir: temp_dir().join("missing"),
        ..StageConfig::default()
    };
    c.vts.url = vts.url();
    c.vts.emotion_hold_ms = 300;
    c.vts.after_speech_ms = 100;
    c.obs.subtitle_source = Some("Subtitle".into());
    c.obs.subtitle_clear_ms = 0;
    c.obs.poll_ms = 100;
    c.lipsync.bind = "127.0.0.1:0".into();
    let mut avatar = AvatarProfile::default();
    avatar.emotions.insert(
        "happy".into(),
        AvatarAction::Expression("happy.exp3.json".into()),
    );
    avatar
        .emotions
        .insert("smug".into(), AvatarAction::Hotkey("Wave".into()));
    c.avatar = avatar;
    c
}

fn expression_requests(vts: &FakeVts) -> Vec<(String, bool)> {
    vts.requests()
        .into_iter()
        .filter(|r| r["messageType"] == "ExpressionActivationRequest")
        .map(|r| {
            (
                r["data"]["expressionFile"].as_str().unwrap().to_owned(),
                r["data"]["active"].as_bool().unwrap(),
            )
        })
        .collect()
}

fn voice_ctx() -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some("g".into()),
        channel: "vc".into(),
        kind: ContextKind::Voice,
    }
}

#[tokio::test]
async fn stage_end_to_end() {
    let (sup, services, bus, module) = core().await;
    let link = services.require::<StageLink>().unwrap();
    let vts = FakeVts::start().await;
    let obs = FakeObs::new("Talk");
    let config = stage_config(&module, &vts);
    let data_dir = config.data_dir.clone();
    let cancel = CancellationToken::new();
    let stage = tokio::spawn(run_stage_with(
        config,
        Arc::new(obs.clone()),
        cancel.clone(),
    ));

    wait_until(|| {
        link.status()
            .is_some_and(|s| s.vts && s.obs && s.scene.as_deref() == Some("Talk"))
    })
    .await;
    assert_eq!(
        std::fs::read_to_string(data_dir.join("vts-token.txt")).unwrap(),
        "tok-1"
    );
    let (_, caps) = link.node().unwrap();
    for cap in ["vts", "obs", "lipsync", "overlay"] {
        assert!(caps.contains(&cap.to_owned()), "{caps:?}");
    }

    // OBS: scenes and streaming.
    let status = link.set_scene("Game").await.unwrap();
    assert_eq!(status.scene.as_deref(), Some("Game"));
    let err = link.set_scene("Missing").await.unwrap_err();
    assert!(err.to_string().contains("Missing"), "{err}");
    let status = link.stream(StreamAction::Start).await.unwrap();
    assert!(status.streaming);
    assert_eq!(
        link.stream(StreamAction::Stop).await.unwrap(),
        StageStatus {
            vts: true,
            obs: true,
            scene: Some("Game".into()),
            streaming: false
        }
    );
    assert_eq!(
        obs.state.lock().calls,
        ["scene Game", "scene Missing", "start", "stop"]
    );

    // VTS: hotkeys, emotions with hold, batched parameter injection.
    link.hotkey("wave").await.unwrap();
    assert!(vts.requests().iter().any(|r| {
        r["messageType"] == "HotkeyTriggerRequest" && r["data"]["hotkeyID"] == "hk-wave"
    }));
    assert!(link.hotkey("Dance").await.is_err());

    let src = ModuleId::from("agent");
    bus.publish(
        &src,
        Event::Custom {
            topic: EMOTION_TOPIC.into(),
            payload: json!({ "emotion": "happy" }),
        },
        None,
    );
    let t0 = Instant::now();
    wait_until(|| expression_requests(&vts) == [("happy.exp3.json".to_owned(), true)]).await;
    wait_until(|| expression_requests(&vts).len() == 2).await;
    assert_eq!(
        expression_requests(&vts)[1],
        ("happy.exp3.json".to_owned(), false)
    );
    assert!(t0.elapsed() >= Duration::from_millis(250), "held");

    wait_until(|| {
        vts.injections().iter().any(|d| {
            let ids: Vec<&str> = d["parameterValues"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["id"].as_str().unwrap())
                .collect();
            ["MouthOpen", "MouthForm", "FaceAngleX", "EyeRightY"]
                .iter()
                .all(|id| ids.contains(id))
        })
    })
    .await;
    let first = vts.injections().len();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let rate = vts.injections().len() - first;
    assert!((5..=45).contains(&rate), "about 60 Hz: {rate} in 500 ms");

    // Subtitles reach the OBS text source.
    let turn = TurnId::new();
    bus.publish(
        &src,
        Event::VoicePlayback {
            context: voice_ctx(),
            turn: Some(turn),
            state: PlaybackState::Started,
            text: "早安。".into(),
        },
        Some(turn),
    );
    wait_until(|| {
        obs.state
            .lock()
            .texts
            .contains(&("Subtitle".to_owned(), "早安。".to_owned()))
    })
    .await;

    cancel.cancel();
    tokio::time::timeout(WAIT, stage)
        .await
        .expect("stage stops")
        .unwrap()
        .unwrap();
    wait_until(|| !link.is_connected()).await;
    sup.stop_all().await;
    let _ = std::fs::remove_dir_all(data_dir);
}

#[tokio::test]
async fn wrong_token_is_fatal() {
    let (sup, _, _, module) = core().await;
    let vts = FakeVts::start().await;
    let mut config = stage_config(&module, &vts);
    config.token = "wrong".into();
    config.vts.enabled = false;
    config.obs.enabled = false;
    let err = tokio::time::timeout(
        WAIT,
        run_stage_with(
            config,
            Arc::new(FakeObs::default()),
            CancellationToken::new(),
        ),
    )
    .await
    .expect("returns")
    .unwrap_err();
    assert!(err.to_string().contains("token"), "{err}");
    sup.stop_all().await;
}

#[tokio::test]
async fn levels_endpoint_feeds_lip_sync() {
    let levels = Arc::new(Levels::new(&LipSyncConfig::default()));
    let cancel = CancellationToken::new();
    let (addr, server) = serve_levels("127.0.0.1:0", levels.clone(), cancel.clone())
        .await
        .unwrap();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/levels"))
        .await
        .unwrap();
    for (t, rms) in [(0, 0.1), (20, 0.3)] {
        ws.send(Message::Text(
            json!({"t": t, "rms": rms}).to_string().into(),
        ))
        .await
        .unwrap();
    }
    wait_until(|| (levels.current(Instant::now()) - 0.3).abs() < 1e-6).await;
    // Without new levels the mouth closes.
    wait_until(|| levels.current(Instant::now()) == 0.0).await;
    cancel.cancel();
    drop(ws);
    tokio::time::timeout(WAIT, server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

async fn http_get(addr: std::net::SocketAddr, path: &str) -> String {
    let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    tcp.write_all(
        format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes(),
    )
    .await
    .unwrap();
    let mut out = String::new();
    tcp.read_to_string(&mut out).await.unwrap();
    out
}

#[tokio::test]
async fn overlay_serves_files_and_events() {
    let dir = temp_dir();
    std::fs::write(dir.join("index.html"), "<p>overlay</p>").unwrap();
    std::fs::write(dir.join("app.js"), "console.log(1)").unwrap();
    let hub = Arc::new(OverlayHub::new());
    hub.status(
        &StageStatus {
            vts: true,
            ..StageStatus::default()
        },
        true,
    );
    let cancel = CancellationToken::new();
    let (addr, _server) = serve_overlay("127.0.0.1:0", dir.clone(), hub.clone(), cancel.clone())
        .await
        .unwrap();

    let index = http_get(addr, "/overlay/").await;
    assert!(index.starts_with("HTTP/1.1 200"), "{index}");
    assert!(index.contains("<p>overlay</p>"));
    assert!(
        http_get(addr, "/overlay/app.js")
            .await
            .contains("console.log(1)")
    );
    let redirect = http_get(addr, "/overlay").await;
    assert!(redirect.starts_with("HTTP/1.1 30"), "{redirect}");
    assert!(
        http_get(addr, "/overlay/nope.js")
            .await
            .starts_with("HTTP/1.1 404")
    );

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/overlay/ws"))
        .await
        .unwrap();
    let mut next = async || -> Value {
        loop {
            let msg = tokio::time::timeout(WAIT, ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let Message::Text(t) = msg {
                return serde_json::from_str(t.as_str()).unwrap();
            }
        }
    };
    assert_eq!(
        next().await,
        json!({"type": "status", "core": true, "vts": true, "obs": false, "scene": null, "streaming": false})
    );
    // The client subscribed before its snapshot was sent.
    hub.subtitle("t1", "早安", false);
    hub.emotion("happy", 0.8);
    assert_eq!(
        next().await,
        json!({"type": "subtitle", "turn": "t1", "text": "早安", "final": false})
    );
    let emotion = next().await;
    assert_eq!(emotion["type"], "emotion");
    assert_eq!(emotion["name"], "happy");
    cancel.cancel();
    let _ = std::fs::remove_dir_all(dir);
}
