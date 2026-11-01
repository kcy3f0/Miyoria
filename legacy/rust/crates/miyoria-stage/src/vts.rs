//! VTube Studio Public API client (`ws://localhost:8001`).
//!
//! Requests are JSON envelopes
//! `{apiName, apiVersion, requestID, messageType, data}`; responses carry the
//! same `requestID`, and failures come back as `messageType: "APIError"` with
//! `{errorID, message}`. Parameter injection is fire and forget and coalesced:
//! when frames are produced faster than the socket drains, only the newest
//! value of each parameter is sent.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

pub const API_NAME: &str = "VTubeStudioPublicAPI";
pub const API_VERSION: &str = "1.0";
/// `errorID` VTS uses when the user denies the plugin.
pub const ERROR_USER_DENIED: i64 = 50;

/// `[vts]` section of the Stage config.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct VtsConfig {
    /// Default true.
    pub enabled: bool,
    /// Default `ws://127.0.0.1:8001`.
    pub url: String,
    /// Plugin name shown in VTS. Default `Miyoria`.
    pub plugin_name: String,
    /// Default `Miyoria`.
    pub plugin_developer: String,
    /// Optional base64 PNG (128×128) shown in the VTS approval dialog.
    pub plugin_icon: Option<String>,
    /// How long an emotion is held. Default 4 000.
    pub emotion_hold_ms: u64,
    /// Minimum time an emotion stays after she stops speaking. Default 1 500.
    pub after_speech_ms: u64,
    /// Expression fade, in seconds. Default 0.3.
    pub expression_fade: f32,
    /// Injection rate. Default 60.
    pub inject_hz: u32,
    /// Tell VTS a face is tracked while injecting. Default false.
    pub face_found: bool,
    /// Inject idle head / eye motion. Default true.
    pub idle_motion: bool,
    /// Timeout of ordinary requests. Default 5 000.
    pub request_timeout_ms: u64,
    /// How long to wait for the user to approve the plugin. Default 120 000.
    pub approval_timeout_ms: u64,
}

impl Default for VtsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            url: "ws://127.0.0.1:8001".to_owned(),
            plugin_name: "Miyoria".to_owned(),
            plugin_developer: "Miyoria".to_owned(),
            plugin_icon: None,
            emotion_hold_ms: 4_000,
            after_speech_ms: 1_500,
            expression_fade: 0.3,
            inject_hz: 60,
            face_found: false,
            idle_motion: true,
            request_timeout_ms: 5_000,
            approval_timeout_ms: 120_000,
        }
    }
}

/// Plugin identity used for authentication.
#[derive(Clone, Debug)]
pub struct PluginInfo {
    pub name: String,
    pub developer: String,
    pub icon: Option<String>,
}

impl From<&VtsConfig> for PluginInfo {
    fn from(c: &VtsConfig) -> Self {
        Self {
            name: c.plugin_name.clone(),
            developer: c.plugin_developer.clone(),
            icon: c.plugin_icon.clone(),
        }
    }
}

/// An `APIError` response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiError {
    pub id: i64,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "VTube Studio error {}: {}", self.id, self.message)
    }
}

impl std::error::Error for ApiError {}

/// Loaded model, from `CurrentModelRequest`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelInfo {
    pub loaded: bool,
    pub name: String,
    pub id: String,
}

/// One hotkey of the current model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hotkey {
    pub name: String,
    pub kind: String,
    pub id: String,
}

/// One expression of the current model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expression {
    pub name: String,
    pub file: String,
    pub active: bool,
}

/// Where the authentication token is kept.
pub fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("vts-token.txt")
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

/// A connection to VTube Studio. Cheap to share behind `Arc`.
pub struct VtsClient {
    out: mpsc::Sender<String>,
    pending: Pending,
    inject: Arc<Mutex<BTreeMap<String, f32>>>,
    inject_face_found: Arc<Mutex<bool>>,
    inject_ready: Arc<Notify>,
    next_id: AtomicU64,
    closed: CancellationToken,
    timeout: Duration,
}

impl Drop for VtsClient {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

impl VtsClient {
    /// Opens the WebSocket. Call [`authenticate`](Self::authenticate) next.
    pub async fn connect(url: &str, timeout: Duration) -> anyhow::Result<Self> {
        let (ws, _) = tokio::time::timeout(timeout, tokio_tungstenite::connect_async(url))
            .await
            .map_err(|_| anyhow::anyhow!("timed out connecting to VTube Studio at {url}"))?
            .map_err(|e| anyhow::anyhow!("cannot connect to VTube Studio at {url}: {e}"))?;
        let (mut sink, mut stream) = ws.split();
        let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
        let pending: Pending = Arc::default();
        let inject: Arc<Mutex<BTreeMap<String, f32>>> = Arc::default();
        let inject_face_found = Arc::new(Mutex::new(false));
        let inject_ready = Arc::new(Notify::new());
        let closed = CancellationToken::new();

        // Writer: requests first, then the newest injection frame.
        {
            let closed = closed.clone();
            let inject = inject.clone();
            let face_found = inject_face_found.clone();
            let ready = inject_ready.clone();
            tokio::spawn(async move {
                let mut n: u64 = 0;
                loop {
                    let text = tokio::select! {
                        biased;
                        () = closed.cancelled() => break,
                        msg = out_rx.recv() => match msg {
                            Some(text) => text,
                            None => break,
                        },
                        () = ready.notified() => {
                            let values = std::mem::take(&mut *inject.lock());
                            if values.is_empty() {
                                continue;
                            }
                            n += 1;
                            inject_message(&format!("inject-{n}"), &values, *face_found.lock())
                        }
                    };
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                closed.cancel();
                let _ = sink.close().await;
            });
        }

        // Reader: routes responses to waiting requests.
        {
            let closed = closed.clone();
            let pending = pending.clone();
            tokio::spawn(async move {
                let mut errors: u64 = 0;
                loop {
                    let msg = tokio::select! {
                        () = closed.cancelled() => break,
                        msg = stream.next() => msg,
                    };
                    let text = match msg {
                        Some(Ok(Message::Text(text))) => text,
                        Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                        Some(Ok(_)) => continue,
                    };
                    let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else {
                        debug!("invalid JSON from VTube Studio");
                        continue;
                    };
                    let id = value["requestID"].as_str().unwrap_or_default().to_owned();
                    let waiter = pending.lock().remove(&id);
                    match waiter {
                        Some(tx) => {
                            let _ = tx.send(value);
                        }
                        None if value["messageType"] == "APIError" => {
                            errors += 1;
                            if errors % 300 == 1 {
                                warn!(
                                    request = %id,
                                    error = %value["data"]["message"],
                                    count = errors,
                                    "VTube Studio rejected a request"
                                );
                            }
                        }
                        // Injection acks and events.
                        None => {}
                    }
                }
                closed.cancel();
                pending.lock().clear();
            });
        }

        Ok(Self {
            out: out_tx,
            pending,
            inject,
            inject_face_found,
            inject_ready,
            next_id: AtomicU64::new(1),
            closed,
            timeout,
        })
    }

    /// The connection is gone.
    pub fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    /// Resolves when the connection is gone.
    pub async fn closed(&self) {
        self.closed.cancelled().await;
    }

    /// Sends a request and returns the response `data`.
    pub async fn request(&self, message_type: &str, data: Value) -> anyhow::Result<Value> {
        self.request_with_timeout(message_type, data, self.timeout)
            .await
    }

    pub async fn request_with_timeout(
        &self,
        message_type: &str,
        data: Value,
        timeout: Duration,
    ) -> anyhow::Result<Value> {
        let id = format!("miyoria-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id.clone(), tx);
        let text = json!({
            "apiName": API_NAME,
            "apiVersion": API_VERSION,
            "requestID": id,
            "messageType": message_type,
            "data": data,
        })
        .to_string();
        let sent = tokio::select! {
            r = self.out.send(text) => r.is_ok(),
            () = self.closed.cancelled() => false,
        };
        if !sent {
            self.pending.lock().remove(&id);
            anyhow::bail!("VTube Studio disconnected");
        }
        let response = tokio::select! {
            r = tokio::time::timeout(timeout, rx) => Some(r),
            () = self.closed.cancelled() => None,
        };
        self.pending.lock().remove(&id);
        let value = match response {
            Some(Ok(Ok(v))) => v,
            Some(Ok(Err(_))) | None => anyhow::bail!("VTube Studio disconnected"),
            Some(Err(_)) => anyhow::bail!("VTube Studio did not answer `{message_type}` in time"),
        };
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        if value["messageType"] == "APIError" {
            return Err(ApiError {
                id: data["errorID"].as_i64().unwrap_or(-1),
                message: data["message"].as_str().unwrap_or_default().to_owned(),
            }
            .into());
        }
        Ok(data)
    }

    /// Authenticates as a plugin. Uses the token stored at `token_file` when
    /// it is still valid; otherwise asks VTS for a new one (the user must
    /// click "Allow" in VTube Studio) and stores it.
    pub async fn authenticate(
        &self,
        plugin: &PluginInfo,
        token_file: &Path,
        approval_timeout: Duration,
    ) -> anyhow::Result<()> {
        if let Some(token) = read_token(token_file) {
            let (ok, reason) = self.auth_with(plugin, &token).await?;
            if ok {
                debug!("authenticated with VTube Studio using the stored token");
                return Ok(());
            }
            warn!(%reason, "stored VTube Studio token was rejected, requesting a new one");
            let _ = std::fs::remove_file(token_file);
        }
        info!("requesting a VTube Studio plugin token: click \"Allow\" in VTube Studio");
        let mut data = json!({
            "pluginName": plugin.name,
            "pluginDeveloper": plugin.developer,
        });
        if let Some(icon) = &plugin.icon {
            data["pluginIcon"] = json!(icon);
        }
        let response = self
            .request_with_timeout("AuthenticationTokenRequest", data, approval_timeout)
            .await
            .map_err(|e| match e.downcast_ref::<ApiError>() {
                Some(api) if api.id == ERROR_USER_DENIED => {
                    anyhow::anyhow!("the plugin was denied in VTube Studio ({})", api.message)
                }
                _ => e,
            })?;
        let token = response["authenticationToken"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| anyhow::anyhow!("VTube Studio sent no authentication token"))?
            .to_owned();
        write_token(token_file, &token)?;
        let (ok, reason) = self.auth_with(plugin, &token).await?;
        if !ok {
            anyhow::bail!("VTube Studio rejected the new token: {reason}");
        }
        info!("authenticated with VTube Studio");
        Ok(())
    }

    async fn auth_with(&self, plugin: &PluginInfo, token: &str) -> anyhow::Result<(bool, String)> {
        let data = self
            .request(
                "AuthenticationRequest",
                json!({
                    "pluginName": plugin.name,
                    "pluginDeveloper": plugin.developer,
                    "authenticationToken": token,
                }),
            )
            .await?;
        Ok((
            data["authenticated"].as_bool().unwrap_or(false),
            data["reason"].as_str().unwrap_or_default().to_owned(),
        ))
    }

    pub async fn current_model(&self) -> anyhow::Result<ModelInfo> {
        let d = self.request("CurrentModelRequest", json!({})).await?;
        Ok(ModelInfo {
            loaded: d["modelLoaded"].as_bool().unwrap_or(false),
            name: d["modelName"].as_str().unwrap_or_default().to_owned(),
            id: d["modelID"].as_str().unwrap_or_default().to_owned(),
        })
    }

    pub async fn hotkeys(&self) -> anyhow::Result<Vec<Hotkey>> {
        let d = self
            .request("HotkeysInCurrentModelRequest", json!({}))
            .await?;
        Ok(d["availableHotkeys"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|h| Hotkey {
                        name: h["name"].as_str().unwrap_or_default().to_owned(),
                        kind: h["type"].as_str().unwrap_or_default().to_owned(),
                        id: h["hotkeyID"].as_str().unwrap_or_default().to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Fires a hotkey given by name (case-insensitive) or id. Returns the id.
    pub async fn trigger_hotkey(&self, name_or_id: &str) -> anyhow::Result<String> {
        let wanted = name_or_id.trim();
        let id = match self.hotkeys().await {
            Ok(list) => list
                .iter()
                .find(|h| h.id == wanted)
                .or_else(|| list.iter().find(|h| h.name.eq_ignore_ascii_case(wanted)))
                .map(|h| h.id.clone())
                .ok_or_else(|| anyhow::anyhow!("the model has no hotkey `{wanted}`"))?,
            Err(e) => {
                debug!(error = %e, "cannot list hotkeys, triggering by name");
                wanted.to_owned()
            }
        };
        self.request("HotkeyTriggerRequest", json!({ "hotkeyID": id }))
            .await?;
        Ok(id)
    }

    pub async fn expressions(&self) -> anyhow::Result<Vec<Expression>> {
        let d = self
            .request("ExpressionStateRequest", json!({ "details": false }))
            .await?;
        Ok(d["expressions"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|e| Expression {
                        name: e["name"].as_str().unwrap_or_default().to_owned(),
                        file: e["file"].as_str().unwrap_or_default().to_owned(),
                        active: e["active"].as_bool().unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn set_expression(&self, file: &str, active: bool, fade: f32) -> anyhow::Result<()> {
        self.request(
            "ExpressionActivationRequest",
            json!({ "expressionFile": file, "active": active, "fadeTime": fade.clamp(0.0, 2.0) }),
        )
        .await?;
        Ok(())
    }

    /// Names of the input parameters (default and custom) VTS knows.
    pub async fn input_parameters(&self) -> anyhow::Result<HashSet<String>> {
        let d = self.request("InputParameterListRequest", json!({})).await?;
        let mut names = HashSet::new();
        for list in ["defaultParameters", "customParameters"] {
            for p in d[list].as_array().into_iter().flatten() {
                if let Some(name) = p["name"].as_str() {
                    names.insert(name.to_owned());
                }
            }
        }
        Ok(names)
    }

    /// Queues parameter values for the next `InjectParameterDataRequest`
    /// (mode `set`). Values not sent yet are merged; newer ones win.
    pub fn inject(&self, values: &[(&str, f32)], face_found: bool) {
        if self.is_closed() || values.is_empty() {
            return;
        }
        {
            let mut batch = self.inject.lock();
            for (id, value) in values {
                if value.is_finite() {
                    batch.insert((*id).to_owned(), *value);
                }
            }
        }
        *self.inject_face_found.lock() = face_found;
        self.inject_ready.notify_one();
    }
}

fn inject_message(id: &str, values: &BTreeMap<String, f32>, face_found: bool) -> String {
    let params: Vec<Value> = values
        .iter()
        .map(|(id, value)| json!({ "id": id, "value": value }))
        .collect();
    json!({
        "apiName": API_NAME,
        "apiVersion": API_VERSION,
        "requestID": id,
        "messageType": "InjectParameterDataRequest",
        "data": { "faceFound": face_found, "mode": "set", "parameterValues": params },
    })
    .to_string()
}

fn read_token(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty())
}

fn write_token(path: &Path, token: &str) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| anyhow::anyhow!("cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(path, token)
        .map_err(|e| anyhow::anyhow!("cannot store the VTS token in {}: {e}", path.display()))
}
