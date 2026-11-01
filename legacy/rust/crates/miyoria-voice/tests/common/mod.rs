//! Test harness: a supervisor running `voice.link` on port 0 and a fake voice
//! node speaking the Voice Link protocol.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use miyoria_kernel::{EventBus, Module, ServiceRegistry, Subscription, Supervisor, TopicFilter};
use miyoria_types::{Envelope, ModuleStateKind};
use miyoria_voice::{VoiceLink, VoiceLinkModule};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

pub const TOKEN: &str = "secret-token";
pub const SELF_ID: &str = "42";
const WAIT: Duration = Duration::from_secs(5);

pub struct Harness {
    pub sup: Supervisor,
    pub services: Arc<ServiceRegistry>,
    pub bus: EventBus,
    pub link_module: Arc<VoiceLinkModule>,
}

impl Harness {
    /// Boots `voice.link` (with `link_config` merged over the defaults) plus
    /// `extra` modules.
    pub async fn start(link_config: Value, extra: Vec<(Arc<dyn Module>, Value)>) -> Self {
        Self::start_with(link_config, extra, |_| {}).await
    }

    pub async fn start_with(
        link_config: Value,
        extra: Vec<(Arc<dyn Module>, Value)>,
        setup: impl FnOnce(&ServiceRegistry),
    ) -> Self {
        let services = Arc::new(ServiceRegistry::new());
        setup(&services);
        let bus = EventBus::default();
        let sup = Supervisor::new(bus.clone(), services.clone());
        let mut config = json!({ "bind": "127.0.0.1:0", "token": TOKEN });
        if let (Some(base), Value::Object(over)) = (config.as_object_mut(), link_config) {
            base.extend(over);
        }
        let link_module = Arc::new(VoiceLinkModule::new());
        sup.register(link_module.clone(), config, true).await;
        for (module, config) in extra {
            sup.register(module, config, true).await;
        }
        sup.start_all().await.unwrap();
        Self {
            sup,
            services,
            bus,
            link_module,
        }
    }

    pub fn addr(&self) -> SocketAddr {
        self.link_module
            .local_addr()
            .expect("voice.link is running")
    }

    pub fn link(&self) -> Arc<VoiceLink> {
        self.services.require::<VoiceLink>().unwrap()
    }

    pub fn subscribe(&self, topics: &[&str]) -> Subscription {
        self.bus.subscribe(TopicFilter::new(topics.iter().copied()))
    }

    pub async fn connect(&self) -> Node {
        Node::connect(self.addr()).await
    }

    /// Connects and authenticates as `account`.
    pub async fn node(&self, account: &str) -> Node {
        let mut node = self.connect().await;
        node.hello(TOKEN, account).await;
        let welcome = node.recv_json().await;
        assert_eq!(welcome["type"], "welcome", "{welcome}");
        assert!(welcome["session"].as_str().is_some_and(|s| !s.is_empty()));
        // Wait until Core has registered the connection.
        let link = self.link();
        wait_until(|| link.self_account().is_some_and(|a| a.id == account)).await;
        node
    }

    pub async fn module_state(&self, id: &str) -> (ModuleStateKind, Option<String>) {
        let s = self
            .sup
            .list()
            .await
            .into_iter()
            .find(|s| s.id.as_str() == id)
            .unwrap();
        (s.state, s.reason)
    }
}

pub async fn wait_until(mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !cond() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition not met in time"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

pub async fn next_event(sub: &mut Subscription) -> Arc<Envelope> {
    tokio::time::timeout(WAIT, sub.recv())
        .await
        .expect("event in time")
        .expect("bus open")
}

pub struct Node {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    /// Answer `{"type":"ping"}` automatically.
    pub auto_pong: bool,
}

impl Node {
    pub async fn connect(addr: SocketAddr) -> Self {
        let (ws, _) = connect_async(format!("ws://{addr}/voice-link"))
            .await
            .expect("connect");
        Self {
            ws,
            auto_pong: true,
        }
    }

    pub async fn send_json(&mut self, value: Value) {
        self.ws
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    pub async fn hello(&mut self, token: &str, account: &str) {
        self.send_json(json!({
            "type": "hello", "version": 1, "token": token, "node": "test-node",
            "self_account": { "platform": "discord", "id": account }
        }))
        .await;
    }

    /// Sends captured audio of `stream` in 20 ms frames.
    pub async fn send_audio(&mut self, stream: u32, samples: &[i16]) {
        for chunk in samples.chunks(320) {
            let mut frame = vec![0x01];
            frame.extend_from_slice(&stream.to_le_bytes());
            for s in chunk {
                frame.extend_from_slice(&s.to_le_bytes());
            }
            self.ws.send(Message::Binary(frame.into())).await.unwrap();
        }
    }

    /// Next data message (JSON or binary); answers pings when `auto_pong`.
    pub async fn recv(&mut self) -> Message {
        loop {
            let msg = tokio::time::timeout(WAIT, self.ws.next())
                .await
                .expect("message in time")
                .expect("socket open")
                .expect("valid message");
            if let Message::Text(text) = &msg {
                if self.auto_pong && text.as_str().contains("\"ping\"") {
                    self.send_json(json!({"type": "pong"})).await;
                    continue;
                }
            }
            if matches!(msg, Message::Ping(_) | Message::Pong(_)) {
                continue;
            }
            return msg;
        }
    }

    pub async fn recv_json(&mut self) -> Value {
        match self.recv().await {
            Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
            other => panic!("expected JSON, got {other:?}"),
        }
    }

    /// Waits for a JSON message of `kind`, skipping others (e.g. audio).
    pub async fn recv_type(&mut self, kind: &str) -> Value {
        loop {
            if let Message::Text(text) = self.recv().await {
                let v: Value = serde_json::from_str(text.as_str()).unwrap();
                if v["type"] == kind {
                    return v;
                }
            }
        }
    }

    /// Waits for the close frame and returns its code.
    pub async fn expect_close(&mut self) -> u16 {
        loop {
            match self.recv().await {
                Message::Close(Some(frame)) => return u16::from(frame.code),
                Message::Close(None) => return u16::from(CloseCode::Status),
                _ => {}
            }
        }
    }
}
