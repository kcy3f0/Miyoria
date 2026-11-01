//! `/api/memory*`: browse, search, edit and delete her long-term memories
//! (active profile).

use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;
use miyoria_memory::MemoryEngine;
use miyoria_memory::tokenize::{token_string, tokenize};
use miyoria_store::{MemoryFilter, MemoryQuery, MemoryRecord, MemoryRecordStore, MemoryScope};
use miyoria_types::ProfileId;
use ulid::Ulid;

use crate::server::{ApiError, ApiResult, ApiState, body, query};
use crate::types::{MemoryItem, MemoryListQuery, MemoryRecordView, Page, UpdateMemoryRequest};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 500;
/// Upper bound when collecting the profile's scopes for a search.
const SCAN_LIMIT: usize = 100_000;
const MAX_CONTENT_CHARS: usize = 4000;

pub(crate) fn routes() -> Router<ApiState> {
    Router::new().route("/api/memory", get(list)).route(
        "/api/memory/{id}",
        axum::routing::patch(update).delete(remove),
    )
}

fn internal(e: anyhow::Error) -> ApiError {
    ApiError::internal(&e)
}

/// The memory module's store and profile, else the app's store and the
/// active profile.
fn records(state: &ApiState) -> Result<(Arc<dyn MemoryRecordStore>, ProfileId), ApiError> {
    if let Some(engine) = state.optional::<MemoryEngine>() {
        return Ok((engine.records().clone(), engine.profile().clone()));
    }
    let store = state.service::<dyn MemoryRecordStore>("memory store")?;
    Ok((store, state.profile()?))
}

async fn list(
    State(state): State<ApiState>,
    q: Result<Query<MemoryListQuery>, QueryRejection>,
) -> ApiResult<Page<MemoryItem>> {
    let q = query(q)?;
    let (store, profile) = records(&state)?;
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let text = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    match text {
        None => {
            let filter = MemoryFilter {
                subject: q.subject,
                scope: None,
                kind: q.kind,
                before: q.before,
                include_superseded: q.include_superseded,
                limit: limit + 1,
            };
            let mut found = store.list(&profile, &filter).await.map_err(internal)?;
            let more = found.len() > limit;
            found.truncate(limit);
            let next_cursor = more
                .then(|| found.last().map(|r| r.created_at.to_rfc3339()))
                .flatten();
            let items = found
                .iter()
                .map(|r| MemoryItem {
                    record: r.into(),
                    text_score: None,
                    vector_score: None,
                })
                .collect();
            Ok(Json(Page { items, next_cursor }))
        }
        Some(text) => search(&*store, &profile, &q, text, limit).await.map(Json),
    }
}

/// Full-text search over every scope of the profile. Superseded records are
/// never returned by a search.
async fn search(
    store: &dyn MemoryRecordStore,
    profile: &ProfileId,
    q: &MemoryListQuery,
    text: &str,
    limit: usize,
) -> Result<Page<MemoryItem>, ApiError> {
    let tokens = tokenize(text);
    if tokens.is_empty() {
        return Ok(Page {
            items: Vec::new(),
            next_cursor: None,
        });
    }
    let all = store
        .list(
            profile,
            &MemoryFilter {
                limit: SCAN_LIMIT,
                ..Default::default()
            },
        )
        .await
        .map_err(internal)?;
    let mut scopes: Vec<MemoryScope> = Vec::new();
    for r in all {
        if !scopes.contains(&r.scope) {
            scopes.push(r.scope);
        }
    }
    if scopes.is_empty() {
        return Ok(Page {
            items: Vec::new(),
            next_cursor: None,
        });
    }
    let hits = store
        .search(&MemoryQuery {
            profile: profile.clone(),
            scopes,
            kinds: q.kind.map(|k| vec![k]),
            tokens,
            embedding: None,
            limit: MAX_LIMIT,
        })
        .await
        .map_err(internal)?;
    let mut hits: Vec<_> = hits
        .into_iter()
        .filter(|h| q.subject.is_none_or(|s| h.record.subjects.contains(&s)))
        .filter(|h| q.before.is_none_or(|b| h.record.created_at < b))
        .collect();
    hits.sort_by(|a, b| {
        let score = |h: &miyoria_store::MemoryHit| h.text_score.max(h.vector_score.unwrap_or(0.0));
        score(b)
            .total_cmp(&score(a))
            .then(b.record.created_at.cmp(&a.record.created_at))
    });
    hits.truncate(limit);
    let items = hits
        .into_iter()
        .map(|h| MemoryItem {
            record: (&h.record).into(),
            text_score: Some(h.text_score),
            vector_score: Some(h.vector_score),
        })
        .collect();
    Ok(Page {
        items,
        next_cursor: None,
    })
}

fn unknown_memory(id: &str) -> ApiError {
    ApiError::not_found(format!("unknown memory `{id}`"))
}

/// The record with this id in the profile.
async fn find(
    store: &dyn MemoryRecordStore,
    profile: &ProfileId,
    id: &str,
) -> Result<MemoryRecord, ApiError> {
    let ulid: Ulid = id.parse().map_err(|_| unknown_memory(id))?;
    store
        .get(ulid)
        .await
        .map_err(internal)?
        .filter(|r| &r.profile == profile)
        .ok_or_else(|| unknown_memory(id))
}

async fn update(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    request: Result<Json<UpdateMemoryRequest>, JsonRejection>,
) -> ApiResult<MemoryRecordView> {
    let request = body(request)?;
    let content = match request.content.as_deref().map(str::trim) {
        Some("") => return Err(ApiError::bad_request("`content` must not be empty")),
        Some(c) if c.chars().count() > MAX_CONTENT_CHARS => {
            return Err(ApiError::bad_request(format!(
                "`content` is longer than {MAX_CONTENT_CHARS} characters"
            )));
        }
        other => other,
    };
    if let Some(i) = request.importance
        && !(0.0..=1.0).contains(&i)
    {
        return Err(ApiError::bad_request(
            "`importance` must be between 0 and 1",
        ));
    }
    let (store, profile) = records(&state)?;
    let mut record = find(&*store, &profile, &id).await?;
    if let Some(content) = content
        && content != record.content
    {
        record.content = content.to_owned();
        record.tokens = token_string(content);
        // The memory module does not expose its embedder; drop the stale
        // vector rather than keep one that describes the old text.
        record.embedding = None;
    }
    if let Some(kind) = request.kind {
        record.kind = kind;
    }
    if let Some(importance) = request.importance {
        record.importance = importance;
    }
    if let Some(done) = request.done {
        record.done = done;
    }
    record.updated_at = Utc::now();
    let result = store.upsert(&record).await;
    let mut detail = serde_json::to_value(&request).unwrap_or_default();
    if let Err(e) = &result {
        detail["error"] = format!("{e:#}").into();
    }
    state
        .audit(
            "memory.update",
            &record.id.to_string(),
            detail,
            result.is_ok(),
        )
        .await;
    result.map_err(internal)?;
    Ok(Json((&record).into()))
}

async fn remove(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (store, profile) = records(&state)?;
    let record = find(&*store, &profile, &id).await?;
    let result = store.delete(record.id).await;
    let detail = serde_json::json!({
        "kind": record.kind,
        "scope": record.scope,
        "content": record.content,
    });
    state
        .audit(
            "memory.delete",
            &record.id.to_string(),
            detail,
            result.is_ok(),
        )
        .await;
    match result.map_err(internal)? {
        true => Ok(StatusCode::NO_CONTENT),
        false => Err(unknown_memory(&id)),
    }
}
