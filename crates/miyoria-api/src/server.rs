//! Router, shared state, errors and the original routes. Every service is
//! looked up per request, because the modules providing them may be stopped
//! or restarted at any time. The route groups live in sibling modules.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use chrono::Utc;
use futures::{Stream, StreamExt};
use miyoria_agent::PersonaHandle;
use miyoria_kernel::{ModuleContext, ModuleStatus, SupervisorHandle, TopicFilter};
use miyoria_llm::LlmRouter;
use miyoria_store::{
    AuditEntry, AuditLog, DecisionLog, DecisionRecord, PersonaOverride, PersonaOverrideStore,
};
use miyoria_types::{ContextKey, ModuleId, ProfileId};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use subtle::ConstantTimeEq;
use tracing::warn;
use ulid::Ulid;

use crate::monitor::Monitor;
use crate::types::{
    CostInfo, ErrorBody, HealthInfo, ModuleInfo, PersonaSectionInfo, SetPersonaRequest,
    SetPersonaResponse, UsageInfo,
};
use crate::{memory, ops, panel, people, roles};

const DEFAULT_DECISIONS: usize = 50;
const MAX_DECISIONS: usize = 1000;

/// Actor recorded in audit entries for changes made through the API.
pub(crate) const ACTOR: &str = "api";

/// The message of the fallback for unknown `/api/*` routes; the panel shows
/// "not provided by this Core" when it sees exactly this.
pub(crate) const NO_SUCH_ENDPOINT: &str = "no such endpoint";

#[derive(Clone)]
pub(crate) struct ApiState {
    pub(crate) ctx: ModuleContext,
    token: Arc<[u8]>,
    pub(crate) monitor: Arc<Monitor>,
    panel: Option<Arc<PathBuf>>,
}

impl ApiState {
    pub(crate) fn service<T>(&self, what: &str) -> Result<Arc<T>, ApiError>
    where
        T: ?Sized + Send + Sync + 'static,
    {
        self.optional::<T>()
            .ok_or_else(|| ApiError::unavailable(format!("{what} is not available")))
    }

    pub(crate) fn optional<T>(&self) -> Option<Arc<T>>
    where
        T: ?Sized + Send + Sync + 'static,
    {
        self.ctx.services().get::<T>()
    }

    pub(crate) fn profile(&self) -> Result<ProfileId, ApiError> {
        self.service::<ProfileId>("active profile id")
            .map(|p| (*p).clone())
    }

    /// Records a change in the audit log, when there is one. Failures to
    /// write are logged, never returned.
    pub(crate) async fn audit(
        &self,
        action: &str,
        target: &str,
        detail: serde_json::Value,
        ok: bool,
    ) {
        let Some(log) = self.optional::<dyn AuditLog>() else {
            return;
        };
        let entry = AuditEntry {
            id: Ulid::new(),
            at: Utc::now(),
            actor: ACTOR.to_owned(),
            action: action.to_owned(),
            target: target.to_owned(),
            detail,
            ok,
        };
        if let Err(e) = log.append(&entry).await {
            warn!(action, error = %format!("{e:#}"), "cannot write audit entry");
        }
    }
}

/// An error response, serialized as `{ "error": "..." }`.
#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }

    /// A downstream node (stage, voice) failed the request.
    pub(crate) fn bad_gateway(error: &anyhow::Error) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, format!("{error:#}"))
    }

    pub(crate) fn internal(error: &anyhow::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(ErrorBody {
                error: self.message,
            }),
        )
            .into_response();
        if self.status == StatusCode::UNAUTHORIZED {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        response
    }
}

impl From<JsonRejection> for ApiError {
    fn from(r: JsonRejection) -> Self {
        Self::new(r.status(), r.body_text())
    }
}

impl From<QueryRejection> for ApiError {
    fn from(r: QueryRejection) -> Self {
        Self::bad_request(r.body_text())
    }
}

/// Unwraps a JSON body, turning a rejection into an [`ApiError`].
pub(crate) fn body<T: DeserializeOwned>(
    body: Result<Json<T>, JsonRejection>,
) -> Result<T, ApiError> {
    Ok(body?.0)
}

/// Unwraps a query string, turning a rejection into an [`ApiError`].
pub(crate) fn query<T: DeserializeOwned>(
    query: Result<Query<T>, QueryRejection>,
) -> Result<T, ApiError> {
    Ok(query?.0)
}

pub(crate) type ApiResult<T> = Result<Json<T>, ApiError>;

/// Builds the API router for a running `api` module.
pub(crate) fn router(
    ctx: ModuleContext,
    token: &str,
    monitor: Arc<Monitor>,
    panel_dir: Option<PathBuf>,
) -> Router {
    let state = ApiState {
        ctx,
        token: Arc::from(token.as_bytes()),
        monitor,
        panel: panel_dir.map(Arc::new),
    };
    let protected = Router::new()
        .route("/api/modules", get(list_modules))
        .route("/api/modules/{id}/{action}", post(module_action))
        .route("/api/decisions", get(decisions))
        .route("/api/llm/usage", get(llm_usage))
        .route("/api/llm/cost", get(llm_cost))
        .route("/api/persona", get(persona))
        .route("/api/persona/{key}", put(set_persona_section))
        .route("/api/persona/{key}/history", get(persona_history))
        .route("/api/events", get(events))
        .merge(people::routes())
        .merge(memory::routes())
        .merge(roles::routes())
        .merge(ops::routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .fallback(fallback)
        .with_state(state)
}

/// Unknown `/api/*` routes get the JSON 404 the panel checks for; anything
/// else is a panel file when a panel directory is configured.
async fn fallback(State(state): State<ApiState>, request: Request) -> Response {
    let path = request.uri().path();
    let is_api = path == "/api" || path.starts_with("/api/");
    match &state.panel {
        Some(dir) if !is_api => panel::serve(dir, request).await,
        _ => ApiError::not_found(NO_SUCH_ENDPOINT).into_response(),
    }
}

async fn require_token(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| bool::from(t.trim().as_bytes().ct_eq(&state.token)));
    if authorized {
        next.run(request).await
    } else {
        ApiError::new(StatusCode::UNAUTHORIZED, "missing or invalid bearer token").into_response()
    }
}

async fn health() -> Json<HealthInfo> {
    Json(HealthInfo {
        status: "ok".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    })
}

async fn list_modules(State(state): State<ApiState>) -> ApiResult<Vec<ModuleInfo>> {
    let sup = state.service::<SupervisorHandle>("supervisor")?;
    Ok(Json(
        sup.list().await.into_iter().map(ModuleInfo::from).collect(),
    ))
}

pub(crate) fn find_module(
    list: Vec<ModuleStatus>,
    id: &ModuleId,
) -> Result<ModuleStatus, ApiError> {
    list.into_iter()
        .find(|m| &m.id == id)
        .ok_or_else(|| ApiError::not_found(format!("unknown module `{id}`")))
}

/// Enables, disables or restarts a module and returns its status afterwards.
/// Refuses to stop the `api` module itself. Recorded in the audit log as
/// `<audit_prefix>.<action>`.
pub(crate) async fn run_module_action(
    state: &ApiState,
    id: &ModuleId,
    action: &str,
    audit_prefix: &str,
) -> Result<ModuleStatus, ApiError> {
    let sup = state.service::<SupervisorHandle>("supervisor")?;
    if !matches!(action, "enable" | "disable" | "restart") {
        return Err(ApiError::not_found(format!(
            "unknown action `{action}` (expected enable, disable or restart)"
        )));
    }
    let current = find_module(sup.list().await, id)?;
    if action != "enable" && id == state.ctx.id() {
        return Err(ApiError::conflict(format!(
            "refusing to {action} `{id}` through itself: it would stop this server"
        )));
    }
    if action == "restart" && !current.enabled {
        return Err(ApiError::conflict(format!(
            "module `{id}` is disabled; enable it instead"
        )));
    }

    let op = async {
        match action {
            "enable" => sup.enable(id).await,
            "disable" => sup.disable(id).await,
            _ => sup.restart(id).await,
        }
    };
    // Don't hold up our own shutdown behind a slow lifecycle operation.
    let result = tokio::select! {
        r = op => r,
        () = state.ctx.cancellation().cancelled() => {
            return Err(ApiError::unavailable("API is shutting down"));
        }
    };
    let detail = match &result {
        Ok(()) => serde_json::json!({}),
        Err(e) => serde_json::json!({ "error": format!("{e:#}") }),
    };
    state
        .audit(
            &format!("{audit_prefix}.{action}"),
            id.as_str(),
            detail,
            result.is_ok(),
        )
        .await;
    result.map_err(|e| ApiError::internal(&e))?;
    find_module(sup.list().await, id)
}

async fn module_action(
    State(state): State<ApiState>,
    Path((id, action)): Path<(String, String)>,
) -> ApiResult<ModuleInfo> {
    let id = ModuleId::from(id);
    let status = run_module_action(&state, &id, &action, "module").await?;
    Ok(Json(status.into()))
}

#[derive(Deserialize)]
struct DecisionsQuery {
    limit: Option<usize>,
    /// JSON-encoded [`ContextKey`].
    context: Option<String>,
}

async fn decisions(
    State(state): State<ApiState>,
    q: Result<Query<DecisionsQuery>, QueryRejection>,
) -> ApiResult<Vec<DecisionRecord>> {
    let q = query(q)?;
    let context = match q.context.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => Some(serde_json::from_str::<ContextKey>(raw).map_err(|e| {
            ApiError::bad_request(format!("`context` must be a JSON context key: {e}"))
        })?),
    };
    let limit = q.limit.unwrap_or(DEFAULT_DECISIONS).min(MAX_DECISIONS);
    let log = state.service::<dyn DecisionLog>("decision log")?;
    let profile = state.profile()?;
    let records = log
        .recent(&profile, context.as_ref(), limit)
        .await
        .map_err(|e| ApiError::internal(&e))?;
    Ok(Json(records))
}

async fn llm_usage(State(state): State<ApiState>) -> ApiResult<BTreeMap<String, UsageInfo>> {
    let router = state.service::<LlmRouter>("LLM router")?;
    Ok(Json(
        router
            .usage()
            .into_iter()
            .map(|(k, v)| (k, v.into()))
            .collect(),
    ))
}

async fn llm_cost(State(state): State<ApiState>) -> ApiResult<CostInfo> {
    let router = state.service::<LlmRouter>("LLM router")?;
    Ok(Json(router.cost_report().into()))
}

async fn persona(State(state): State<ApiState>) -> ApiResult<Vec<PersonaSectionInfo>> {
    let persona = state.service::<PersonaHandle>("persona")?;
    Ok(Json(
        persona
            .sections()
            .into_iter()
            .map(|s| PersonaSectionInfo {
                key: s.key,
                body: s.body,
            })
            .collect(),
    ))
}

fn check_section_key(key: &str) -> Result<(), ApiError> {
    let valid = !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "invalid persona section key `{key}` (use letters, digits, `-` or `_`)"
        )))
    }
}

async fn set_persona_section(
    State(state): State<ApiState>,
    Path(key): Path<String>,
    request: Result<Json<SetPersonaRequest>, JsonRejection>,
) -> ApiResult<SetPersonaResponse> {
    let request = body(request)?;
    check_section_key(&key)?;
    let persona = state.service::<PersonaHandle>("persona")?;
    let overrides = state.service::<dyn PersonaOverrideStore>("persona override store")?;
    let profile = state.profile()?;
    let edited_by = request
        .edited_by
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(ACTOR);
    let text = request.body.trim();
    // Persist first, so a failed write never leaves an unrecorded live edit.
    let result = overrides.set(&profile, &key, text, edited_by).await;
    let detail = match &result {
        Ok(version) => serde_json::json!({ "version": version, "edited_by": edited_by }),
        Err(e) => serde_json::json!({ "edited_by": edited_by, "error": format!("{e:#}") }),
    };
    state
        .audit("persona.set", &key, detail, result.is_ok())
        .await;
    let version = result.map_err(|e| ApiError::internal(&e))?;
    persona.set_section(&key, text);
    Ok(Json(SetPersonaResponse { key, version }))
}

async fn persona_history(
    State(state): State<ApiState>,
    Path(key): Path<String>,
) -> ApiResult<Vec<PersonaOverride>> {
    check_section_key(&key)?;
    let overrides = state.service::<dyn PersonaOverrideStore>("persona override store")?;
    let profile = state.profile()?;
    let history = overrides
        .history(&profile, &key)
        .await
        .map_err(|e| ApiError::internal(&e))?;
    Ok(Json(history))
}

#[derive(Deserialize)]
struct EventsQuery {
    /// Comma-separated topic patterns; empty means everything.
    topics: Option<String>,
}

async fn events(
    State(state): State<ApiState>,
    q: Result<Query<EventsQuery>, QueryRejection>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let q = query(q)?;
    let patterns: Vec<String> = q
        .topics
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    let filter = if patterns.is_empty() {
        TopicFilter::all()
    } else {
        TopicFilter::new(patterns)
    };
    let sub = state.ctx.subscribe(filter);
    let stopped = state.ctx.cancellation().clone().cancelled_owned();
    let stream = futures::stream::unfold(sub, |mut sub| async move {
        sub.recv().await.map(|env| (env, sub))
    })
    .filter_map(|env| async move {
        match SseEvent::default().id(env.id.to_string()).json_data(&*env) {
            Ok(event) => Some(Ok(event)),
            Err(e) => {
                warn!(error = %e, "failed to serialize event for SSE");
                None
            }
        }
    })
    .take_until(stopped);
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
