//! Roles, permission grants, platform role mappings and the audit log.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use miyoria_types::{AccountRef, ContextKey, PlatformId};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

/// A role and the permission nodes it grants. Node patterns may end in `.*`
/// (`"queue.*"`) or be `"*"`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleDefinition {
    pub name: String,
    /// Higher outranks lower (owner 100, admin 80, moderator 60, trusted 40,
    /// user 20, restricted 10, blocked 0).
    pub rank: i32,
    pub grants: Vec<String>,
    pub denies: Vec<String>,
    /// Built-in roles can be edited but not deleted.
    pub builtin: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthScope {
    Global,
    Guild { platform: PlatformId, guild: String },
    Channel { context: ContextKey },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleAssignment {
    pub account: AccountRef,
    pub role: String,
    pub scope: AuthScope,
    /// e.g. `"discord:123"` or `"config"`.
    pub granted_by: String,
    pub at: DateTime<Utc>,
}

/// Platform role (e.g. a Discord role id) → Miyoria role, per guild.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleMapping {
    pub platform: PlatformId,
    pub guild: String,
    pub platform_role: String,
    pub role: String,
}

/// Allow / deny a node for a role in one scope (e.g. let `user` use
/// `voice.join` only in one guild).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeOverride {
    pub scope: AuthScope,
    pub role: String,
    pub node: String,
    pub allow: bool,
}

#[async_trait]
pub trait AuthStore: Send + Sync {
    async fn roles(&self) -> anyhow::Result<Vec<RoleDefinition>>;
    async fn upsert_role(&self, role: &RoleDefinition) -> anyhow::Result<()>;
    async fn delete_role(&self, name: &str) -> anyhow::Result<bool>;

    async fn assignments_for(&self, account: &AccountRef) -> anyhow::Result<Vec<RoleAssignment>>;
    async fn all_assignments(&self) -> anyhow::Result<Vec<RoleAssignment>>;
    /// Replaces an assignment with the same (account, role, scope).
    async fn assign(&self, assignment: &RoleAssignment) -> anyhow::Result<()>;
    async fn revoke(
        &self,
        account: &AccountRef,
        role: &str,
        scope: &AuthScope,
    ) -> anyhow::Result<bool>;

    async fn mappings(
        &self,
        platform: &PlatformId,
        guild: &str,
    ) -> anyhow::Result<Vec<RoleMapping>>;
    async fn set_mapping(&self, mapping: &RoleMapping) -> anyhow::Result<()>;
    async fn remove_mapping(
        &self,
        platform: &PlatformId,
        guild: &str,
        platform_role: &str,
    ) -> anyhow::Result<bool>;

    async fn overrides(&self) -> anyhow::Result<Vec<NodeOverride>>;
    /// Replaces an override with the same (scope, role, node).
    async fn set_override(&self, node_override: &NodeOverride) -> anyhow::Result<()>;
    async fn remove_override(
        &self,
        scope: &AuthScope,
        role: &str,
        node: &str,
    ) -> anyhow::Result<bool>;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: Ulid,
    pub at: DateTime<Utc>,
    /// Who did it, e.g. `"discord:123"`, `"api"`, `"cli"`.
    pub actor: String,
    /// e.g. `"module.disable"`, `"role.assign"`, `"memory.forget"`.
    pub action: String,
    pub target: String,
    pub detail: serde_json::Value,
    pub ok: bool,
}

#[async_trait]
pub trait AuditLog: Send + Sync {
    async fn append(&self, entry: &AuditEntry) -> anyhow::Result<()>;
    /// Newest first, optionally only one actor's entries.
    async fn recent(&self, limit: usize, actor: Option<&str>) -> anyhow::Result<Vec<AuditEntry>>;
}
