//! `/api/auth/*`: roles, role assignments and platform role mappings.
//! Changes go through the `auth` module's [`AuthService`] (which keeps its
//! cache in sync and writes the audit log); reads fall back to the store.

use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use miyoria_auth::AuthService;
use miyoria_store::{AuthStore, RoleAssignment, RoleDefinition, RoleMapping};
use miyoria_types::PlatformId;
use serde::Deserialize;

use crate::server::{ACTOR, ApiError, ApiResult, ApiState, body, query};
use crate::types::{AssignRoleRequest, RemoveMappingRequest, UpsertRoleRequest};

pub(crate) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/auth/roles", get(roles))
        .route(
            "/api/auth/roles/{name}",
            get(role).put(upsert_role).delete(delete_role),
        )
        .route(
            "/api/auth/assignments",
            get(assignments).post(assign).delete(revoke),
        )
        .route(
            "/api/auth/mappings",
            get(mappings).put(set_mapping).delete(remove_mapping),
        )
}

fn internal(e: anyhow::Error) -> ApiError {
    ApiError::internal(&e)
}

fn auth(state: &ApiState) -> Result<Arc<AuthService>, ApiError> {
    state.service::<AuthService>("auth module")
}

fn unknown_role(name: &str) -> ApiError {
    ApiError::not_found(format!("unknown role `{name}`"))
}

/// Highest rank first.
async fn all_roles(state: &ApiState) -> Result<Vec<RoleDefinition>, ApiError> {
    if let Some(auth) = state.optional::<AuthService>() {
        return Ok(auth.roles());
    }
    let store = state.service::<dyn AuthStore>("auth store")?;
    let mut roles = store.roles().await.map_err(internal)?;
    roles.sort_by(|a, b| b.rank.cmp(&a.rank).then_with(|| a.name.cmp(&b.name)));
    Ok(roles)
}

async fn roles(State(state): State<ApiState>) -> ApiResult<Vec<RoleDefinition>> {
    Ok(Json(all_roles(&state).await?))
}

async fn role(
    State(state): State<ApiState>,
    Path(name): Path<String>,
) -> ApiResult<RoleDefinition> {
    all_roles(&state)
        .await?
        .into_iter()
        .find(|r| r.name == name)
        .map(Json)
        .ok_or_else(|| unknown_role(&name))
}

async fn upsert_role(
    State(state): State<ApiState>,
    Path(name): Path<String>,
    request: Result<Json<UpsertRoleRequest>, JsonRejection>,
) -> ApiResult<RoleDefinition> {
    let request = body(request)?;
    let auth = auth(&state)?;
    let role = RoleDefinition {
        name: name.clone(),
        rank: request.rank,
        grants: request.grants,
        denies: request.denies,
        builtin: false,
    };
    auth.upsert_role(ACTOR, role)
        .await
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    auth.role(&name)
        .map(Json)
        .ok_or_else(|| unknown_role(&name))
}

async fn delete_role(
    State(state): State<ApiState>,
    Path(name): Path<String>,
) -> Result<StatusCode, ApiError> {
    let auth = auth(&state)?;
    if auth.role(&name).is_none() {
        return Err(unknown_role(&name));
    }
    match auth.delete_role(ACTOR, &name).await {
        Ok(true) => Ok(StatusCode::NO_CONTENT),
        Ok(false) => Err(unknown_role(&name)),
        Err(e) => Err(ApiError::conflict(format!("{e:#}"))),
    }
}

async fn assignments(State(state): State<ApiState>) -> ApiResult<Vec<RoleAssignment>> {
    let store = state.service::<dyn AuthStore>("auth store")?;
    let mut all = store.all_assignments().await.map_err(internal)?;
    all.sort_by_key(|a| std::cmp::Reverse(a.at));
    Ok(Json(all))
}

async fn find_assignment(
    state: &ApiState,
    request: &AssignRoleRequest,
) -> Result<Option<RoleAssignment>, ApiError> {
    let store = state.service::<dyn AuthStore>("auth store")?;
    Ok(store
        .assignments_for(&request.account)
        .await
        .map_err(internal)?
        .into_iter()
        .find(|a| a.role == request.role && a.scope == request.scope))
}

async fn assign(
    State(state): State<ApiState>,
    request: Result<Json<AssignRoleRequest>, JsonRejection>,
) -> ApiResult<RoleAssignment> {
    let request = body(request)?;
    let auth = auth(&state)?;
    if auth.role(&request.role).is_none() {
        return Err(unknown_role(&request.role));
    }
    if find_assignment(&state, &request).await?.is_some() {
        return Err(ApiError::conflict(format!(
            "`{}:{}` already has role `{}` in that scope",
            request.account.platform, request.account.id, request.role
        )));
    }
    auth.assign(
        ACTOR,
        &request.account,
        &request.role,
        request.scope.clone(),
    )
    .await
    .map_err(internal)?;
    find_assignment(&state, &request)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::internal(&anyhow::anyhow!("the assignment was not stored")))
}

async fn revoke(
    State(state): State<ApiState>,
    request: Result<Json<AssignRoleRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let request = body(request)?;
    let auth = auth(&state)?;
    let removed = auth
        .revoke(ACTOR, &request.account, &request.role, &request.scope)
        .await
        .map_err(internal)?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("no such role assignment"))
    }
}

#[derive(Deserialize)]
struct MappingsQuery {
    platform: String,
    guild: String,
}

async fn mappings(
    State(state): State<ApiState>,
    q: Result<Query<MappingsQuery>, QueryRejection>,
) -> ApiResult<Vec<RoleMapping>> {
    let q = query(q)?;
    let platform = PlatformId::new(q.platform.trim());
    let guild = q.guild.trim();
    let list = match state.optional::<AuthService>() {
        Some(auth) => auth.mappings(&platform, guild).await,
        None => {
            let store = state.service::<dyn AuthStore>("auth store")?;
            store.mappings(&platform, guild).await
        }
    };
    Ok(Json(list.map_err(internal)?))
}

async fn set_mapping(
    State(state): State<ApiState>,
    request: Result<Json<RoleMapping>, JsonRejection>,
) -> ApiResult<RoleMapping> {
    let mapping = body(request)?;
    if mapping.guild.trim().is_empty() || mapping.platform_role.trim().is_empty() {
        return Err(ApiError::bad_request(
            "`guild` and `platform_role` must not be empty",
        ));
    }
    let auth = auth(&state)?;
    if auth.role(&mapping.role).is_none() {
        return Err(unknown_role(&mapping.role));
    }
    auth.map_role(ACTOR, mapping.clone())
        .await
        .map_err(internal)?;
    Ok(Json(mapping))
}

async fn remove_mapping(
    State(state): State<ApiState>,
    request: Result<Json<RemoveMappingRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let request = body(request)?;
    let auth = auth(&state)?;
    let removed = auth
        .unmap_role(
            ACTOR,
            &request.platform,
            &request.guild,
            &request.platform_role,
        )
        .await
        .map_err(internal)?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("no such role mapping"))
    }
}
