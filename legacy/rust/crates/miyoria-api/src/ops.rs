//! Live operation: extensions, MCP servers, the request queue, the stage
//! (VTube Studio / OBS) and the voice monitor.

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use miyoria_ext_host::{CatalogEntry, ExtensionCatalog};
use miyoria_kernel::{ModuleStatus, SupervisorHandle};
use miyoria_mcp::{McpModule, McpStatus, ServerState, ServerStatus};
use miyoria_queue::{ItemState, QueueError, RequestQueue};
use miyoria_stage::{StageLink, StreamAction};
use miyoria_tools::ToolRegistry;
use miyoria_types::{ModuleId, ModuleStateKind, TurnId, VoiceSink};
use tracing::warn;

use crate::server::{ApiError, ApiResult, ApiState, body, run_module_action};
use crate::types::{
    ExpressionRequest, ExtensionInfo, McpServerInfo, McpState, McpToolInfo, MoveRequest,
    QueueItemInfo, QueueState, SayRequest, SayResponse, SceneRequest, StageLinkState, StageState,
    StreamRequest, VoiceState,
};

const MAX_SAY_CHARS: usize = 500;

pub(crate) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/extensions", get(extensions))
        .route("/api/extensions/{id}/{action}", post(extension_action))
        .route("/api/mcp", get(mcp_servers))
        .route("/api/mcp/{name}/{action}", post(mcp_action))
        .route("/api/queue", get(queue))
        .route("/api/queue/pause", post(queue_pause))
        .route("/api/queue/resume", post(queue_resume))
        .route("/api/queue/{id}/{action}", post(queue_item_action))
        .route("/api/stage", get(stage))
        .route("/api/stage/scene", post(stage_scene))
        .route("/api/stage/expression", post(stage_expression))
        .route("/api/stage/stream", post(stage_stream))
        .route("/api/stage/say", post(stage_say))
        .route("/api/voice", get(voice))
}

// ----- extensions -----------------------------------------------------------

fn permissions(entry: &CatalogEntry) -> Vec<String> {
    let granted = &entry.spec.granted;
    let mut out = Vec::new();
    if granted.tools {
        out.push("tools".to_owned());
    }
    if granted.commands {
        out.push("commands".to_owned());
    }
    out.extend(granted.events.iter().map(|e| format!("events:{e}")));
    out.extend(granted.network.iter().map(|n| format!("network:{n}")));
    out.extend(granted.input.iter().map(|i| format!("input:{i}")));
    out
}

fn extension_info(entry: &CatalogEntry, status: Option<&ModuleStatus>) -> ExtensionInfo {
    let manifest = &entry.spec.manifest;
    let (enabled, state, reason) = match status {
        Some(s) => (s.enabled, s.state, s.reason.clone()),
        None => (
            false,
            ModuleStateKind::Disabled,
            Some("not registered with the supervisor".to_owned()),
        ),
    };
    ExtensionInfo {
        id: manifest.id.clone(),
        module: entry.spec.module_id(),
        name: manifest.name.clone().unwrap_or_else(|| manifest.id.clone()),
        version: manifest.version.clone(),
        description: manifest.description.clone().unwrap_or_default(),
        source: entry.spec.dir.display().to_string(),
        enabled,
        state,
        reason,
        permissions: permissions(entry),
    }
}

async fn extensions(State(state): State<ApiState>) -> ApiResult<Vec<ExtensionInfo>> {
    let catalog = state.service::<ExtensionCatalog>("extension host")?;
    let sup = state.service::<SupervisorHandle>("supervisor")?;
    let modules = sup.list().await;
    Ok(Json(
        catalog
            .entries
            .iter()
            .map(|e| {
                let id = e.spec.module_id();
                extension_info(e, modules.iter().find(|m| m.id == id))
            })
            .collect(),
    ))
}

async fn extension_action(
    State(state): State<ApiState>,
    Path((id, action)): Path<(String, String)>,
) -> ApiResult<ExtensionInfo> {
    let catalog = state.service::<ExtensionCatalog>("extension host")?;
    let entry = catalog
        .entries
        .iter()
        .find(|e| e.spec.manifest.id == id || e.spec.module_id().as_str() == id)
        .ok_or_else(|| ApiError::not_found(format!("unknown extension `{id}`")))?;
    let module = entry.spec.module_id();
    let status = run_module_action(&state, &module, &action, "extension").await?;
    Ok(Json(extension_info(entry, Some(&status))))
}

// ----- MCP ------------------------------------------------------------------

fn mcp_info(s: ServerStatus, tools: Option<&ToolRegistry>) -> McpServerInfo {
    let state = match s.state {
        ServerState::Disabled => McpState::Disabled,
        ServerState::Connecting => McpState::Connecting,
        ServerState::Connected => McpState::Ready,
        ServerState::Failed => McpState::Failed,
    };
    let tools = s
        .tools
        .iter()
        .map(|name| McpToolInfo {
            name: name.clone(),
            description: tools
                .and_then(|r| r.get(name))
                .map(|t| t.spec().description)
                .unwrap_or_default(),
        })
        .collect();
    McpServerInfo {
        name: s.name,
        transport: s.transport,
        target: None,
        enabled: s.state != ServerState::Disabled,
        state,
        error: s.last_error,
        tools,
        remote_tool_count: s.remote_tool_count,
        permission: s.permission,
        reconnects: s.reconnects,
    }
}

async fn mcp_servers(State(state): State<ApiState>) -> ApiResult<Vec<McpServerInfo>> {
    let status = state.service::<McpStatus>("MCP module")?;
    let tools = state.optional::<ToolRegistry>();
    Ok(Json(
        status
            .servers()
            .into_iter()
            .map(|s| mcp_info(s, tools.as_deref()))
            .collect(),
    ))
}

/// Only `restart` is supported (it restarts the whole `mcp` module); turning
/// single servers on or off is configuration (`[mcp.servers.<name>] enabled`).
async fn mcp_action(
    State(state): State<ApiState>,
    Path((name, action)): Path<(String, String)>,
) -> ApiResult<McpServerInfo> {
    let status = state.service::<McpStatus>("MCP module")?;
    if status.server(&name).is_none() {
        return Err(ApiError::not_found(format!("unknown MCP server `{name}`")));
    }
    match action.as_str() {
        "restart" => {}
        "enable" | "disable" => {
            return Err(ApiError::conflict(format!(
                "MCP servers are turned on and off in miyoria.toml \
                 (`[mcp.servers.{name}] enabled`); only restart is available at runtime"
            )));
        }
        _ => {
            return Err(ApiError::not_found(format!(
                "unknown action `{action}` (expected enable, disable or restart)"
            )));
        }
    }
    let module = ModuleId::from(McpModule::ID);
    run_module_action(&state, &module, "restart", "mcp").await?;
    // The restarted module provides a fresh status.
    let status = state.service::<McpStatus>("MCP module")?;
    let server = status
        .server(&name)
        .ok_or_else(|| ApiError::unavailable(format!("MCP server `{name}` is restarting")))?;
    let tools = state.optional::<ToolRegistry>();
    Ok(Json(mcp_info(server, tools.as_deref())))
}

// ----- request queue --------------------------------------------------------

fn queue_state(queue: &RequestQueue) -> QueueState {
    QueueState {
        paused: queue.is_paused(),
        items: queue.list().into_iter().map(QueueItemInfo::from).collect(),
    }
}

fn queue_error(e: QueueError) -> ApiError {
    match e {
        QueueError::NotFound(_) => ApiError::not_found(e.to_string()),
        _ => ApiError::conflict(e.to_string()),
    }
}

async fn queue(State(state): State<ApiState>) -> ApiResult<QueueState> {
    let queue = state.service::<RequestQueue>("request queue")?;
    Ok(Json(queue_state(&queue)))
}

async fn set_paused(state: &ApiState, paused: bool) -> ApiResult<QueueState> {
    let queue = state.service::<RequestQueue>("request queue")?;
    if paused {
        queue.pause();
    } else {
        queue.resume();
    }
    let action = if paused {
        "queue.pause"
    } else {
        "queue.resume"
    };
    state
        .audit(action, "queue", serde_json::json!({}), true)
        .await;
    Ok(Json(queue_state(&queue)))
}

async fn queue_pause(State(state): State<ApiState>) -> ApiResult<QueueState> {
    set_paused(&state, true).await
}

async fn queue_resume(State(state): State<ApiState>) -> ApiResult<QueueState> {
    set_paused(&state, false).await
}

/// `POST /api/queue/{id}/skip` and `POST /api/queue/{id}/move`.
async fn queue_item_action(
    State(state): State<ApiState>,
    Path((id, action)): Path<(String, String)>,
    request: Result<Json<MoveRequest>, JsonRejection>,
) -> ApiResult<QueueState> {
    let queue = state.service::<RequestQueue>("request queue")?;
    let item: u64 = id
        .trim()
        .trim_start_matches('#')
        .parse()
        .map_err(|_| ApiError::not_found(format!("no item #{id}")))?;
    let (result, detail) = match action.as_str() {
        "skip" => (queue.skip(item).map(drop), serde_json::json!({})),
        "move" => {
            let request = body(request)?;
            // The listing puts active items first; `move_item` counts pending
            // items only.
            let active = queue
                .list()
                .iter()
                .filter(|i| i.state == ItemState::Active)
                .count();
            let position = request.position.saturating_sub(active);
            (
                queue.move_item(item, position),
                serde_json::json!({ "position": request.position }),
            )
        }
        _ => {
            return Err(ApiError::not_found(format!(
                "unknown action `{action}` (expected skip or move)"
            )));
        }
    };
    if !matches!(result, Err(QueueError::NotFound(_))) {
        let mut detail = detail;
        if let Err(e) = &result {
            detail["error"] = e.to_string().into();
        }
        state
            .audit(
                &format!("queue.{action}"),
                &item.to_string(),
                detail,
                result.is_ok(),
            )
            .await;
    }
    result.map_err(queue_error)?;
    Ok(Json(queue_state(&queue)))
}

// ----- stage ----------------------------------------------------------------

fn stage_state(state: &ApiState, link: &StageLink) -> StageState {
    let node = link.node().map(|(name, _)| name);
    let status = link.status().unwrap_or_default();
    let part = |connected: bool, what: &str| StageLinkState {
        connected: node.is_some() && connected,
        error: if node.is_none() {
            Some("stage node not connected".to_owned())
        } else if connected {
            None
        } else {
            Some(format!("{what} is not connected on the stage node"))
        },
    };
    StageState {
        vts: part(status.vts, "VTube Studio"),
        obs: part(status.obs, "OBS"),
        scene: status.scene.clone(),
        scenes: Vec::new(),
        expression: state.monitor.expression(),
        expressions: Vec::new(),
        overlay_url: None,
        speaking: state.monitor.speaking(),
        node,
        streaming: status.streaming,
    }
}

fn stage_link(state: &ApiState) -> Result<Arc<StageLink>, ApiError> {
    state.service::<StageLink>("stage link")
}

async fn stage(State(state): State<ApiState>) -> ApiResult<StageState> {
    let link = stage_link(&state)?;
    Ok(Json(stage_state(&state, &link)))
}

fn require_obs(state: &ApiState, link: &StageLink) -> Result<(), ApiError> {
    let current = stage_state(state, link);
    if current.obs.connected {
        Ok(())
    } else {
        Err(ApiError::conflict(
            current
                .obs
                .error
                .unwrap_or_else(|| "OBS is not connected".to_owned()),
        ))
    }
}

async fn stage_scene(
    State(state): State<ApiState>,
    request: Result<Json<SceneRequest>, JsonRejection>,
) -> ApiResult<StageState> {
    let request = body(request)?;
    let scene = request.scene.trim();
    if scene.is_empty() {
        return Err(ApiError::bad_request("`scene` must not be empty"));
    }
    let link = stage_link(&state)?;
    require_obs(&state, &link)?;
    let result = link.set_scene(scene).await;
    state
        .audit("stage.scene", scene, serde_json::json!({}), result.is_ok())
        .await;
    result.map_err(|e| ApiError::bad_gateway(&e))?;
    Ok(Json(stage_state(&state, &link)))
}

async fn stage_stream(
    State(state): State<ApiState>,
    request: Result<Json<StreamRequest>, JsonRejection>,
) -> ApiResult<StageState> {
    let request = body(request)?;
    let link = stage_link(&state)?;
    require_obs(&state, &link)?;
    let result = link.stream(request.action).await;
    let target = match request.action {
        StreamAction::Start => "start",
        StreamAction::Stop => "stop",
    };
    state
        .audit(
            "stage.stream",
            target,
            serde_json::json!({}),
            result.is_ok(),
        )
        .await;
    result.map_err(|e| ApiError::bad_gateway(&e))?;
    Ok(Json(stage_state(&state, &link)))
}

async fn stage_expression(
    State(state): State<ApiState>,
    request: Result<Json<ExpressionRequest>, JsonRejection>,
) -> ApiResult<StageState> {
    let request = body(request)?;
    let expression = request.expression.trim();
    if expression.is_empty() {
        return Err(ApiError::bad_request("`expression` must not be empty"));
    }
    let link = stage_link(&state)?;
    let current = stage_state(&state, &link);
    if !current.vts.connected {
        return Err(ApiError::conflict(
            current
                .vts
                .error
                .unwrap_or_else(|| "VTube Studio is not connected".to_owned()),
        ));
    }
    let result = link.hotkey(expression).await;
    state
        .audit(
            "stage.expression",
            expression,
            serde_json::json!({}),
            result.is_ok(),
        )
        .await;
    result.map_err(|e| ApiError::bad_gateway(&e))?;
    state.monitor.set_expression(expression);
    Ok(Json(stage_state(&state, &link)))
}

/// Speaks `text` through TTS in the voice channel she is in, without the
/// LLM. Returns as soon as speaking started; the turn id correlates the
/// `voice.playback` events.
async fn stage_say(
    State(state): State<ApiState>,
    request: Result<Json<SayRequest>, JsonRejection>,
) -> ApiResult<SayResponse> {
    let request = body(request)?;
    let text = request.text.trim().to_owned();
    if text.is_empty() {
        return Err(ApiError::bad_request("`text` must not be empty"));
    }
    if text.chars().count() > MAX_SAY_CHARS {
        return Err(ApiError::bad_request(format!(
            "`text` is longer than {MAX_SAY_CHARS} characters"
        )));
    }
    let sink = state.service::<dyn VoiceSink>("voice module")?;
    let context = state
        .monitor
        .voice_context()
        .ok_or_else(|| ApiError::conflict("she is not in a voice channel"))?;
    let emotion = request
        .emotion
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let turn = TurnId::new();
    state
        .audit(
            "stage.say",
            &context.to_string(),
            serde_json::json!({ "text": text, "emotion": emotion, "turn": turn }),
            true,
        )
        .await;
    tokio::spawn(async move {
        if let Err(e) = sink
            .speak(&context, &text, emotion.as_deref(), Some(turn))
            .await
        {
            warn!(error = %format!("{e:#}"), "speaking from the API failed");
        }
    });
    Ok(Json(SayResponse { turn: Some(turn) }))
}

// ----- voice ----------------------------------------------------------------

async fn voice(State(state): State<ApiState>) -> Json<VoiceState> {
    Json(state.monitor.voice(Utc::now()))
}
