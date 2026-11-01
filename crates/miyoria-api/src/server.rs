//! Routes and handlers. Every service is looked up per request, because the
//! modules providing them may be stopped or restarted at any time.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures::{Stream, StreamExt};
use miyoria_agent::PersonaHandle;
use miyoria_kernel::{ModuleContext, ModuleStatus, SupervisorHandle, TopicFilter};
use miyoria_llm::LlmRouter;
use miyoria_store::{DecisionLog, DecisionRecord, PersonaOverride, PersonaOverrideStore};
use miyoria_types::{ContextKey, ModuleId, ProfileId};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tracing::warn;

use crate::types::{
    ErrorBody, HealthInfo, ModuleInfo, PersonaSectionInfo, SetPersonaRequest, SetPersonaResponse,
    UsageInfo,
};

const DEFAULT_DECISIONS: usize = 50;
const MAX_DECISIONS: usize = 1000;

#[derive(Clone)]
struct ApiState {
    ctx: ModuleContext,
    token: Arc<[u8]>,
}

impl ApiState {
    fn service<T>(&self, what: &str) -> Result<Arc<T>, ApiError>
    where
        T: ?Sized + Send + Sync + 'static,
    {
        self.ctx
            .services()
            .get::<T>()
            .ok_or_else(|| ApiError::unavailable(format!("{what} is not available")))
    }

    fn profile(&self) -> Result<ProfileId, ApiError> {
        self.service::<ProfileId>("active profile id")
            .map(|p| (*p).clone())
    }
}

/// An error response, serialized as `{ "error": "..." }`.
#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }

    fn internal(error: &anyhow::Error) -> Self {
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

/// Builds the API router for a running `api` module.
pub(crate) fn router(ctx: ModuleContext, token: &str) -> Router {
    let state = ApiState {
        ctx,
        token: Arc::from(token.as_bytes()),
    };
    let protected = Router::new()
        .route("/api/modules", get(list_modules))
        .route("/api/modules/{id}/{action}", post(module_action))
        .route("/api/decisions", get(decisions))
        .route("/api/llm/usage", get(llm_usage))
        .route("/api/persona", get(persona))
        .route("/api/persona/{key}", put(set_persona_section))
        .route("/api/persona/{key}/history", get(persona_history))
        .route("/api/events", get(events))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .fallback(|| async { ApiError::not_found("no such endpoint") })
        .with_state(state)
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

async fn list_modules(State(state): State<ApiState>) -> Result<Json<Vec<ModuleInfo>>, ApiError> {
    let sup = state.service::<SupervisorHandle>("supervisor")?;
    Ok(Json(
        sup.list().await.into_iter().map(ModuleInfo::from).collect(),
    ))
}

fn find(list: Vec<ModuleStatus>, id: &ModuleId) -> Result<ModuleStatus, ApiError> {
    list.into_iter()
        .find(|m| &m.id == id)
        .ok_or_else(|| ApiError::not_found(format!("unknown module `{id}`")))
}

async fn module_action(
    State(state): State<ApiState>,
    Path((id, action)): Path<(String, String)>,
) -> Result<Json<ModuleInfo>, ApiError> {
    let sup = state.service::<SupervisorHandle>("supervisor")?;
    let id = ModuleId::from(id);
    if !matches!(action.as_str(), "enable" | "disable" | "restart") {
        return Err(ApiError::not_found(format!(
            "unknown action `{action}` (expected enable, disable or restart)"
        )));
    }
    let current = find(sup.list().await, &id)?;
    if action != "enable" && &id == state.ctx.id() {
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
        match action.as_str() {
            "enable" => sup.enable(&id).await,
            "disable" => sup.disable(&id).await,
            _ => sup.restart(&id).await,
        }
    };
    // Don't hold up our own shutdown behind a slow lifecycle operation.
    let result = tokio::select! {
        r = op => r,
        () = state.ctx.cancellation().cancelled() => {
            return Err(ApiError::unavailable("API is shutting down"));
        }
    };
    result.map_err(|e| ApiError::internal(&e))?;
    Ok(Json(find(sup.list().await, &id)?.into()))
}

#[derive(Deserialize)]
struct DecisionsQuery {
    limit: Option<usize>,
    /// JSON-encoded [`ContextKey`].
    context: Option<String>,
}

async fn decisions(
    State(state): State<ApiState>,
    query: Result<Query<DecisionsQuery>, QueryRejection>,
) -> Result<Json<Vec<DecisionRecord>>, ApiError> {
    let Query(query) = query?;
    let context = match query.context.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => Some(serde_json::from_str::<ContextKey>(raw).map_err(|e| {
            ApiError::bad_request(format!("`context` must be a JSON context key: {e}"))
        })?),
    };
    let limit = query.limit.unwrap_or(DEFAULT_DECISIONS).min(MAX_DECISIONS);
    let log = state.service::<dyn DecisionLog>("decision log")?;
    let profile = state.profile()?;
    let records = log
        .recent(&profile, context.as_ref(), limit)
        .await
        .map_err(|e| ApiError::internal(&e))?;
    Ok(Json(records))
}

async fn llm_usage(
    State(state): State<ApiState>,
) -> Result<Json<BTreeMap<String, UsageInfo>>, ApiError> {
    let router = state.service::<LlmRouter>("LLM router")?;
    Ok(Json(
        router
            .usage()
            .into_iter()
            .map(|(k, v)| (k, v.into()))
            .collect(),
    ))
}

async fn persona(State(state): State<ApiState>) -> Result<Json<Vec<PersonaSectionInfo>>, ApiError> {
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
    body: Result<Json<SetPersonaRequest>, JsonRejection>,
) -> Result<Json<SetPersonaResponse>, ApiError> {
    let Json(request) = body?;
    check_section_key(&key)?;
    let persona = state.service::<PersonaHandle>("persona")?;
    let overrides = state.service::<dyn PersonaOverrideStore>("persona override store")?;
    let profile = state.profile()?;
    let edited_by = request
        .edited_by
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("api");
    let body = request.body.trim();
    // Persist first, so a failed write never leaves an unrecorded live edit.
    let version = overrides
        .set(&profile, &key, body, edited_by)
        .await
        .map_err(|e| ApiError::internal(&e))?;
    persona.set_section(&key, body);
    Ok(Json(SetPersonaResponse { key, version }))
}

async fn persona_history(
    State(state): State<ApiState>,
    Path(key): Path<String>,
) -> Result<Json<Vec<PersonaOverride>>, ApiError> {
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
    query: Result<Query<EventsQuery>, QueryRejection>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let Query(query) = query?;
    let patterns: Vec<String> = query
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
