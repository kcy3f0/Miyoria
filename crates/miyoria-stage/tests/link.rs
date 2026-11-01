//! Stage Link protocol tests: `stage.link` on a real socket and a scripted
//! Stage node.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use miyoria_commands::{ArgValue, CommandRegistry, Invocation, Permissions};
use miyoria_kernel::{EventBus, ServiceRegistry, Subscription, Supervisor, TopicFilter};
use miyoria_stage::link::{EMOTION_TOPIC, STATUS_TOPIC};
use miyoria_stage::{GazeTarget, StageLink, StageLinkModule, StreamAction};
use miyoria_types::{
    AccountRef, ContextKey, ContextKind, Envelope, Event, ModuleId, ModuleStateKind, PlatformId,
    PlaybackState, TurnId,
};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const TOKEN: &str = "stage-secret";
const WAIT: Duration = Duration::from_secs(5);

struct Harness {
    sup: Supervisor,
    services: Arc<ServiceRegistry>,
    bus: EventBus,
    module: Arc<StageLinkModule>,
}

impl Harness {
    async fn start(config: Value) -> Self {
        let services = Arc::new(ServiceRegistry::new());
        services.provide(
            &ModuleId::from("commands"),
            Arc::new(CommandRegistry::new(Permissions::default())),
        );
        let bus = EventBus::default();
        let sup = Supervisor::new(bus.clone(), services.clone());
        let mut base = json!({ "bind": "127.0.0.1:0", "token": TOKEN });
        if let (Some(b), Value::Object(over)) = (base.as_object_mut(), config) {
            b.extend(over);
        }
        let module = Arc::new(StageLinkModule::new());
        sup.register(module.clone(), base, true).await;
        sup.start_all().await.unwrap();
        Self {
            sup,
            services,
            bus,
            module,
        }
    }

    fn addr(&self) -> SocketAddr {
        self.module.local_addr().expect("running")
    }

    fn link(&self) -> Arc<StageLink> {
        self.services.require::<StageLink>().unwrap()
    }

    fn registry(&self) -> Arc<CommandRegistry> {
        self.services.require::<CommandRegistry>().unwrap()
    }

    fn subscribe(&self, topics: &[&str]) -> Subscription {
        self.bus.subscribe(TopicFilter::new(topics.iter().copied()))
    }

    fn publish(&self, event: Event) {
        self.bus.publish(&ModuleId::from("test"), event, None);
    }

    async fn node(&self) -> Node {
        let mut node = Node::connect(self.addr()).await;
        node.hello(TOKEN).await;
        let welcome = node.recv_json().await;
        assert_eq!(welcome["type"], "welcome", "{welcome}");
        let link = self.link();
        wait_until(|| link.is_connected()).await;
        node
    }
}

async fn wait_until(mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !cond() {
        assert!(tokio::time::Instant::now() < deadline, "condition not met");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn next_event(sub: &mut Subscription) -> Arc<Envelope> {
    tokio::time::timeout(WAIT, sub.recv())
        .await
        .expect("event in time")
        .expect("bus open")
}

struct Node {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Node {
    async fn connect(addr: SocketAddr) -> Self {
        let (ws, _) = connect_async(format!("ws://{addr}/stage-link"))
            .await
            .expect("connect");
        Self { ws }
    }

    async fn send_json(&mut self, value: Value) {
        self.ws
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    async fn hello(&mut self, token: &str) {
        self.send_json(json!({
            "type": "hello", "version": 1, "token": token, "node": "test-stage",
            "capabilities": ["vts", "obs"]
        }))
        .await;
    }

    /// Next JSON message, answering pings.
    async fn recv_json(&mut self) -> Value {
        loop {
            let msg = tokio::time::timeout(WAIT, self.ws.next())
                .await
                .expect("message in time")
                .expect("socket open")
                .expect("valid message");
            match msg {
                Message::Text(text) => {
                    let v: Value = serde_json::from_str(text.as_str()).unwrap();
                    if v["type"] == "ping" {
                        self.send_json(json!({"type": "pong"})).await;
                        continue;
                    }
                    return v;
                }
                Message::Ping(_) | Message::Pong(_) => {}
                other => panic!("unexpected {other:?}"),
            }
        }
    }

    async fn expect_close(&mut self) -> u16 {
        loop {
            match tokio::time::timeout(WAIT, self.ws.next())
                .await
                .expect("close in time")
            {
                Some(Ok(Message::Close(Some(frame)))) => return frame.code.into(),
                Some(Ok(Message::Close(None))) | None | Some(Err(_)) => return 1005,
                Some(Ok(_)) => {}
            }
        }
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

fn invocation(path: &str) -> Invocation {
    Invocation::new(
        path,
        AccountRef {
            platform: PlatformId::new("discord"),
            id: "7".into(),
        },
        ContextKey {
            platform: PlatformId::new("discord"),
            scope: Some("g1".into()),
            channel: "c1".into(),
            kind: ContextKind::Channel,
        },
    )
}

#[tokio::test]
async fn empty_token_fails_to_start() {
    let h = Harness::start(json!({ "token": "" })).await;
    let mut state = None;
    for _ in 0..200 {
        let s = h
            .sup
            .list()
            .await
            .into_iter()
            .find(|s| s.id.as_str() == "stage.link")
            .unwrap();
        if s.state == ModuleStateKind::Failed {
            state = Some(s);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let state = state.expect("module failed");
    assert!(state.reason.unwrap().contains("STAGE_LINK_TOKEN"));
    h.sup.stop_all().await;
}

#[tokio::test]
async fn hello_is_authenticated_and_newer_node_wins() {
    let h = Harness::start(json!({ "hello_timeout_ms": 300 })).await;

    let mut wrong = Node::connect(h.addr()).await;
    wrong.hello("nope").await;
    assert_eq!(wrong.expect_close().await, 4401);

    let mut old = Node::connect(h.addr()).await;
    old.send_json(json!({"type": "hello", "version": 9, "token": TOKEN}))
        .await;
    assert_eq!(old.expect_close().await, 4400);

    let mut silent = Node::connect(h.addr()).await;
    assert_eq!(silent.expect_close().await, 4400);
    assert!(!h.link().is_connected());

    let mut status = h.subscribe(&[STATUS_TOPIC]);
    let mut first = h.node().await;
    let link = h.link();
    assert_eq!(
        link.node(),
        Some((
            "test-stage".to_owned(),
            vec!["vts".to_owned(), "obs".to_owned()]
        ))
    );
    assert_eq!(next_event(&mut status).await.event.topic(), STATUS_TOPIC);

    first
        .send_json(json!({"type": "status", "vts": true, "obs": true, "scene": "Talk", "streaming": false}))
        .await;
    wait_until(|| link.status().is_some_and(|s| s.vts && s.obs)).await;
    assert_eq!(link.status().unwrap().scene.as_deref(), Some("Talk"));

    let _second = h.node().await;
    assert_eq!(first.expect_close().await, 4409);
    assert!(link.is_connected());
    h.sup.stop_all().await;
}

#[tokio::test]
async fn forwards_emotions_speaking_and_subtitles() {
    let h = Harness::start(json!({})).await;
    let mut node = h.node().await;
    let turn = TurnId::new();

    h.publish(Event::Custom {
        topic: EMOTION_TOPIC.into(),
        payload: json!({ "turn": turn, "context": voice_ctx(), "emotion": "annoyed" }),
    });
    assert_eq!(
        node.recv_json().await,
        json!({"type": "emotion", "name": "annoyed", "intensity": 1.0})
    );

    h.publish(Event::VoicePlayback {
        context: voice_ctx(),
        turn: Some(turn),
        state: PlaybackState::Started,
        text: "哼,".into(),
    });
    assert_eq!(
        node.recv_json().await,
        json!({"type": "speaking", "state": "started"})
    );
    assert_eq!(
        node.recv_json().await,
        json!({"type": "subtitle", "turn": turn.to_string(), "text": "哼,", "final": false})
    );
    h.publish(Event::AgentTurnCompleted {
        turn,
        context: voice_ctx(),
        text: "哼,".into(),
    });
    h.publish(Event::VoicePlayback {
        context: voice_ctx(),
        turn: Some(turn),
        state: PlaybackState::Finished,
        text: "哼,".into(),
    });
    assert_eq!(
        node.recv_json().await,
        json!({"type": "speaking", "state": "stopped"})
    );
    assert_eq!(
        node.recv_json().await,
        json!({"type": "subtitle", "turn": turn.to_string(), "text": "哼,", "final": true})
    );

    h.link().gaze(GazeTarget::Game).unwrap();
    assert_eq!(
        node.recv_json().await,
        json!({"type": "gaze", "target": "game"})
    );
    h.sup.stop_all().await;
}

#[tokio::test]
async fn requests_are_answered_by_id() {
    let h = Harness::start(json!({ "request_timeout_ms": 500 })).await;
    let link = h.link();
    assert!(link.set_scene("Game").await.is_err(), "no node yet");
    let mut node = h.node().await;

    let pending = {
        let link = link.clone();
        tokio::spawn(async move { link.set_scene("Game").await })
    };
    let req = node.recv_json().await;
    assert_eq!(req["type"], "scene");
    assert_eq!(req["name"], "Game");
    let id = req["id"].as_u64().unwrap();
    node.send_json(json!({"type": "status", "vts": false, "obs": true, "scene": "Game", "streaming": false, "id": id}))
        .await;
    let status = pending.await.unwrap().unwrap();
    assert_eq!(status.scene.as_deref(), Some("Game"));

    let pending = {
        let link = link.clone();
        tokio::spawn(async move { link.stream(StreamAction::Start).await })
    };
    let req = node.recv_json().await;
    assert_eq!(req["type"], "stream");
    assert_eq!(req["action"], "start");
    let id = req["id"].as_u64().unwrap();
    node.send_json(json!({"type": "error", "message": "OBS is not connected", "id": id}))
        .await;
    let err = pending.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("OBS is not connected"));

    // Unanswered requests time out.
    let err = link.hotkey("Wave").await.unwrap_err();
    assert!(err.to_string().contains("in time"), "{err}");
    assert_eq!(node.recv_json().await["type"], "avatar_hotkey");
    h.sup.stop_all().await;
}

/// Answers the next request with `status`; returns the request.
async fn answer(node: &mut Node, mut status: Value) -> Value {
    let req = node.recv_json().await;
    status["id"] = req["id"].clone();
    status["type"] = json!("status");
    node.send_json(status).await;
    req
}

#[tokio::test]
async fn stream_commands() {
    let h = Harness::start(json!({})).await;
    let registry = h.registry();
    let reply = registry
        .dispatch(invocation("stream status"))
        .await
        .unwrap();
    assert!(reply.text.contains("沒連上"), "{}", reply.text);

    let mut node = h.node().await;

    let call = tokio::spawn({
        let registry = registry.clone();
        async move { registry.dispatch(invocation("stream start")).await }
    });
    let req = answer(
        &mut node,
        json!({"vts": true, "obs": true, "scene": "Talk", "streaming": true}),
    )
    .await;
    assert_eq!(req["action"], "start");
    let reply = call.await.unwrap().unwrap();
    assert!(!reply.ephemeral);
    assert!(reply.text.contains("開台"), "{}", reply.text);

    let call = tokio::spawn({
        let registry = registry.clone();
        async move {
            registry
                .dispatch(
                    invocation("stream scene").with_arg("name", ArgValue::String("Game".into())),
                )
                .await
        }
    });
    let req = answer(
        &mut node,
        json!({"vts": true, "obs": true, "scene": "Game", "streaming": true}),
    )
    .await;
    assert_eq!(req["name"], "Game");
    assert!(call.await.unwrap().unwrap().text.contains("Game"));

    let call = tokio::spawn({
        let registry = registry.clone();
        async move { registry.dispatch(invocation("stream status")).await }
    });
    let req = answer(
        &mut node,
        json!({"vts": false, "obs": true, "scene": "Game", "streaming": true}),
    )
    .await;
    assert_eq!(req["type"], "status_request");
    let reply = call.await.unwrap().unwrap();
    assert!(reply.ephemeral);
    assert!(
        reply.text.contains("直播中") && reply.text.contains("Game"),
        "{}",
        reply.text
    );

    let paths: Vec<String> = registry.specs().iter().map(|s| s.name()).collect();
    for p in miyoria_stage::link::commands::PATHS {
        assert!(paths.contains(&(*p).to_owned()), "{p} registered");
    }
    let spec = registry
        .get(&["stream".to_owned(), "start".to_owned()])
        .unwrap();
    assert_eq!(spec.permission, "stream.start");

    h.sup.stop_all().await;
    for p in miyoria_stage::link::commands::PATHS {
        let path: Vec<String> = p.split(' ').map(str::to_owned).collect();
        assert!(registry.get(&path).is_none(), "{p} unregistered on stop");
    }
}
