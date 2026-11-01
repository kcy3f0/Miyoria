//! A fake VTube Studio and a fake OBS.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use miyoria_stage::obs::{Obs, ObsConnector};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

pub const WAIT: Duration = Duration::from_secs(5);

pub async fn wait_until(mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !cond() {
        assert!(tokio::time::Instant::now() < deadline, "condition not met");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// A fresh directory under the system temp dir.
pub fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("miyoria-stage-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[derive(Default)]
pub struct VtsState {
    /// Every request received, in order.
    pub requests: Vec<Value>,
    /// The token `AuthenticationRequest` accepts.
    pub valid_token: Option<String>,
    pub tokens_issued: u32,
    /// Answer `AuthenticationTokenRequest` with "user denied".
    pub deny: bool,
}

/// Speaks the VTS Public API envelope on a local port.
pub struct FakeVts {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<VtsState>>,
}

impl FakeVts {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let state: Arc<Mutex<VtsState>> = Arc::default();
        let shared = state.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let state = shared.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    while let Some(Ok(msg)) = ws.next().await {
                        let Message::Text(text) = msg else { continue };
                        let req: Value = serde_json::from_str(text.as_str()).unwrap();
                        let reply = respond(&state, &req);
                        if ws
                            .send(Message::Text(reply.to_string().into()))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                });
            }
        });
        Self { addr, state }
    }

    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }

    pub fn requests(&self) -> Vec<Value> {
        self.state.lock().requests.clone()
    }

    pub fn types(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|r| r["messageType"].as_str().unwrap().to_owned())
            .filter(|t| t != "InjectParameterDataRequest")
            .collect()
    }

    pub fn injections(&self) -> Vec<Value> {
        self.requests()
            .into_iter()
            .filter(|r| r["messageType"] == "InjectParameterDataRequest")
            .map(|r| r["data"].clone())
            .collect()
    }

    pub fn clear(&self) {
        self.state.lock().requests.clear();
    }
}

fn respond(state: &Mutex<VtsState>, req: &Value) -> Value {
    let mut st = state.lock();
    st.requests.push(req.clone());
    let kind = req["messageType"].as_str().unwrap_or_default();
    let data = &req["data"];
    let ok = |t: &str, data: Value| (format!("{t}Response"), data);
    let (message_type, data) = match kind {
        "AuthenticationTokenRequest" if st.deny => (
            "APIError".to_owned(),
            json!({"errorID": 50, "message": "User has denied API access for your plugin."}),
        ),
        "AuthenticationTokenRequest" => {
            st.tokens_issued += 1;
            let token = format!("tok-{}", st.tokens_issued);
            st.valid_token = Some(token.clone());
            ok(
                "AuthenticationToken",
                json!({ "authenticationToken": token }),
            )
        }
        "AuthenticationRequest" => {
            let good = st.valid_token.as_deref() == data["authenticationToken"].as_str()
                && data["pluginName"] == "Miyoria";
            ok(
                "Authentication",
                json!({ "authenticated": good, "reason": if good { "Token valid." } else { "Token invalid." } }),
            )
        }
        "CurrentModelRequest" => ok(
            "CurrentModel",
            json!({"modelLoaded": true, "modelName": "DeepSeek-chan", "modelID": "m1"}),
        ),
        "HotkeysInCurrentModelRequest" => ok(
            "HotkeysInCurrentModel",
            json!({"modelLoaded": true, "availableHotkeys": [
                {"name": "Wave", "type": "TriggerAnimation", "hotkeyID": "hk-wave"},
                {"name": "Clear", "type": "RemoveAllExpressions", "hotkeyID": "hk-clear"}
            ]}),
        ),
        "HotkeyTriggerRequest" => ok("HotkeyTrigger", json!({ "hotkeyID": data["hotkeyID"] })),
        "ExpressionStateRequest" => ok(
            "ExpressionState",
            json!({"modelLoaded": true, "expressions": [
                {"name": "happy", "file": "happy.exp3.json", "active": false}
            ]}),
        ),
        "ExpressionActivationRequest" => ok("ExpressionActivation", json!({})),
        "InputParameterListRequest" => {
            let defaults: Vec<Value> = [
                "MouthOpen",
                "MouthSmile",
                "FaceAngleX",
                "FaceAngleY",
                "FaceAngleZ",
                "EyeLeftX",
                "EyeLeftY",
                "EyeRightX",
                "EyeRightY",
            ]
            .iter()
            .map(|n| json!({ "name": n }))
            .collect();
            ok(
                "InputParameterList",
                json!({ "defaultParameters": defaults, "customParameters": [{"name": "MouthForm"}] }),
            )
        }
        "InjectParameterDataRequest" => ok("InjectParameterData", json!({})),
        _ => (
            "APIError".to_owned(),
            json!({"errorID": 2, "message": format!("unknown request {kind}")}),
        ),
    };
    json!({
        "apiName": "VTubeStudioPublicAPI",
        "apiVersion": "1.0",
        "timestamp": 0,
        "requestID": req["requestID"],
        "messageType": message_type,
        "data": data,
    })
}

#[derive(Default)]
pub struct ObsState {
    pub scene: String,
    pub streaming: bool,
    pub texts: Vec<(String, String)>,
    pub calls: Vec<String>,
    pub connected: bool,
    pub fail_connect: bool,
}

/// In-memory OBS.
#[derive(Clone, Default)]
pub struct FakeObs {
    pub state: Arc<Mutex<ObsState>>,
}

impl FakeObs {
    pub fn new(scene: &str) -> Self {
        let obs = Self::default();
        obs.state.lock().scene = scene.to_owned();
        obs
    }
}

#[async_trait]
impl Obs for FakeObs {
    async fn current_scene(&self) -> anyhow::Result<String> {
        Ok(self.state.lock().scene.clone())
    }

    async fn set_scene(&self, name: &str) -> anyhow::Result<()> {
        let mut st = self.state.lock();
        st.calls.push(format!("scene {name}"));
        if name == "Missing" {
            anyhow::bail!("No source was found by the name of `Missing`.");
        }
        st.scene = name.to_owned();
        Ok(())
    }

    async fn streaming(&self) -> anyhow::Result<bool> {
        Ok(self.state.lock().streaming)
    }

    async fn start_stream(&self) -> anyhow::Result<()> {
        let mut st = self.state.lock();
        st.calls.push("start".into());
        st.streaming = true;
        Ok(())
    }

    async fn stop_stream(&self) -> anyhow::Result<()> {
        let mut st = self.state.lock();
        st.calls.push("stop".into());
        st.streaming = false;
        Ok(())
    }

    async fn set_text(&self, source: &str, text: &str) -> anyhow::Result<()> {
        self.state
            .lock()
            .texts
            .push((source.to_owned(), text.to_owned()));
        Ok(())
    }
}

#[async_trait]
impl ObsConnector for FakeObs {
    async fn connect(&self) -> anyhow::Result<Arc<dyn Obs>> {
        if self.state.lock().fail_connect {
            anyhow::bail!("connection refused");
        }
        self.state.lock().connected = true;
        Ok(Arc::new(self.clone()))
    }
}
