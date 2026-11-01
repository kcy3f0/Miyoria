//! [`AuthService`]: the cached authorizer and role management API.

use std::collections::HashSet;
use std::sync::{Arc, Weak};
use std::time::Duration;

use anyhow::Context as _;
use chrono::Utc;
use miyoria_store::{
    AuditEntry, AuditLog, AuthScope, AuthStore, NodeOverride, RoleAssignment, RoleDefinition,
    RoleMapping,
};
use miyoria_types::{AccountRef, Authorizer, PlatformId, Subject};
use parking_lot::{Mutex, RwLock};
use serde_json::json;
use tracing::{debug, info, warn};
use ulid::Ulid;

use crate::builtin::builtin_roles;
use crate::node::is_valid_pattern;
use crate::resolve::{GuildKey, Resolution, Snapshot, guild_of};

/// How long a permission check may wait for a guild's role mappings.
const PRELOAD_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_ROLE_NAME: usize = 32;

/// Role-based authorizer backed by an [`AuthStore`], with everything cached
/// in memory. Provided by the `auth` module as `Arc<AuthService>` and as
/// `Arc<dyn Authorizer>`.
///
/// Every write goes to the store first, then refreshes the affected part of
/// the cache, and is recorded in the [`AuditLog`] when there is one. Platform
/// role mappings are loaded per guild on first use (see
/// [`preload`](Self::preload)); [`reload`](Self::reload) re-reads everything.
pub struct AuthService {
    store: Arc<dyn AuthStore>,
    audit: Option<Arc<dyn AuditLog>>,
    state: RwLock<Snapshot>,
    loading: Mutex<HashSet<GuildKey>>,
    me: Weak<Self>,
}

impl AuthService {
    /// Seeds missing built-in roles and loads the cache.
    pub async fn load(
        store: Arc<dyn AuthStore>,
        audit: Option<Arc<dyn AuditLog>>,
        owners: impl IntoIterator<Item = AccountRef>,
        default_role: &str,
    ) -> anyhow::Result<Arc<Self>> {
        let service = Arc::new_cyclic(|me| Self {
            store,
            audit,
            state: RwLock::new(Snapshot {
                owners: owners.into_iter().collect(),
                default_role: default_role.to_owned(),
                ..Snapshot::default()
            }),
            loading: Mutex::new(HashSet::new()),
            me: me.clone(),
        });
        let seeded = service.seed_builtins().await?;
        if seeded > 0 {
            info!(count = seeded, "seeded built-in roles");
        }
        service.reload().await?;
        if !service.state.read().roles.contains_key(default_role) {
            warn!(
                role = default_role,
                "default role does not exist; unassigned users get nothing"
            );
        }
        Ok(service)
    }

    /// Writes the built-in roles that are missing from the store. Existing
    /// ones (possibly edited) are left alone. Returns how many were written.
    pub async fn seed_builtins(&self) -> anyhow::Result<usize> {
        let existing: HashSet<String> = self
            .store
            .roles()
            .await
            .context("loading roles")?
            .into_iter()
            .map(|r| r.name)
            .collect();
        let mut seeded = 0;
        for role in builtin_roles() {
            if !existing.contains(&role.name) {
                self.store.upsert_role(&role).await?;
                seeded += 1;
            }
        }
        Ok(seeded)
    }

    /// Re-reads roles, assignments, overrides and the mappings of every
    /// guild seen so far.
    pub async fn reload(&self) -> anyhow::Result<()> {
        let roles = self.store.roles().await.context("loading roles")?;
        let assignments = self
            .store
            .all_assignments()
            .await
            .context("loading role assignments")?;
        let overrides = self.store.overrides().await.context("loading overrides")?;
        let guilds: Vec<GuildKey> = self.state.read().mappings.keys().cloned().collect();
        let mut mappings = Vec::with_capacity(guilds.len());
        for key in guilds {
            let maps = self
                .store
                .mappings(&key.0, &key.1)
                .await
                .context("loading role mappings")?;
            mappings.push((key, maps));
        }
        let mut state = self.state.write();
        state.roles = roles.into_iter().map(|r| (r.name.clone(), r)).collect();
        state.set_assignments(assignments);
        state.overrides = overrides;
        state.mappings.extend(mappings);
        Ok(())
    }

    /// Replaces the config owners.
    pub fn set_owners(&self, owners: impl IntoIterator<Item = AccountRef>) {
        self.state.write().owners = owners.into_iter().collect();
    }

    pub fn is_config_owner(&self, account: &AccountRef) -> bool {
        self.state.read().owners.contains(account)
    }

    pub fn default_role(&self) -> String {
        self.state.read().default_role.clone()
    }

    /// All roles, highest rank first.
    pub fn roles(&self) -> Vec<RoleDefinition> {
        let mut roles: Vec<_> = self.state.read().roles.values().cloned().collect();
        roles.sort_by(|a, b| b.rank.cmp(&a.rank).then_with(|| a.name.cmp(&b.name)));
        roles
    }

    pub fn role(&self, name: &str) -> Option<RoleDefinition> {
        self.state.read().roles.get(name).cloned()
    }

    pub fn assignments_for(&self, account: &AccountRef) -> Vec<RoleAssignment> {
        self.state
            .read()
            .assignments
            .get(account)
            .cloned()
            .unwrap_or_default()
    }

    pub fn overrides(&self) -> Vec<NodeOverride> {
        self.state.read().overrides.clone()
    }

    /// A guild's platform role mappings, loading them if needed.
    pub async fn mappings(
        &self,
        platform: &PlatformId,
        guild: &str,
    ) -> anyhow::Result<Vec<RoleMapping>> {
        let key = (platform.clone(), guild.to_owned());
        if let Some(maps) = self.state.read().mappings.get(&key) {
            return Ok(maps.clone());
        }
        self.load_mappings(key).await
    }

    /// Resolves the effective role from the cache. If the subject's guild
    /// mappings are not cached yet they are ignored this time and loaded in
    /// the background; call [`preload`](Self::preload) first to avoid that.
    pub fn resolve(&self, subject: &Subject) -> Resolution {
        let resolution = self.state.read().resolve(subject);
        if resolution.mappings_missing {
            self.load_in_background(subject);
        }
        resolution
    }

    /// May `subject` use `node`? Same caching rules as [`resolve`](Self::resolve).
    pub fn check(&self, subject: &Subject, node: &str) -> bool {
        let state = self.state.read();
        let resolution = state.resolve(subject);
        let allowed = state.check(subject, &resolution, node);
        drop(state);
        if resolution.mappings_missing {
            self.load_in_background(subject);
        }
        allowed
    }

    /// Makes sure the role mappings of the subject's guild are cached.
    pub async fn preload(&self, subject: &Subject) {
        let Some(key) = guild_of(subject.context.as_ref()) else {
            return;
        };
        if self.state.read().mappings.contains_key(&key) {
            return;
        }
        match tokio::time::timeout(PRELOAD_TIMEOUT, self.load_mappings(key)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => warn!(error = %format!("{e:#}"), "cannot load role mappings"),
            Err(_) => warn!("loading role mappings timed out"),
        }
    }

    async fn load_mappings(&self, key: GuildKey) -> anyhow::Result<Vec<RoleMapping>> {
        let maps = self
            .store
            .mappings(&key.0, &key.1)
            .await
            .context("loading role mappings")?;
        self.state.write().mappings.insert(key, maps.clone());
        Ok(maps)
    }

    fn load_in_background(&self, subject: &Subject) {
        let Some(key) = guild_of(subject.context.as_ref()) else {
            return;
        };
        let (Ok(rt), Some(me)) = (tokio::runtime::Handle::try_current(), self.me.upgrade()) else {
            return;
        };
        if !self.loading.lock().insert(key.clone()) {
            return;
        }
        debug!(platform = %key.0, guild = %key.1, "loading role mappings in the background");
        rt.spawn(async move {
            if let Err(e) = me.load_mappings(key.clone()).await {
                warn!(error = %format!("{e:#}"), "cannot load role mappings");
            }
            me.loading.lock().remove(&key);
        });
    }

    /// Creates or replaces a role. Built-in roles stay built in; new roles
    /// never are.
    pub async fn upsert_role(&self, actor: &str, mut role: RoleDefinition) -> anyhow::Result<()> {
        role.builtin = self.role(&role.name).is_some_and(|r| r.builtin);
        let result = async {
            validate_role_name(&role.name)?;
            if let Some(bad) = role
                .grants
                .iter()
                .chain(&role.denies)
                .find(|p| !is_valid_pattern(p))
            {
                anyhow::bail!("invalid permission node `{bad}`");
            }
            self.store.upsert_role(&role).await?;
            self.refresh_roles().await
        }
        .await;
        self.record(
            actor,
            "role.upsert",
            &role.name,
            json!(role),
            result.is_ok(),
        )
        .await;
        result
    }

    /// Deletes a custom role. Built-in roles and the default role cannot be
    /// deleted. Assignments of a deleted role are ignored from then on.
    pub async fn delete_role(&self, actor: &str, name: &str) -> anyhow::Result<bool> {
        let result = async {
            if self.role(name).is_some_and(|r| r.builtin) {
                anyhow::bail!("built-in role `{name}` cannot be deleted");
            }
            if name == self.default_role() {
                anyhow::bail!("`{name}` is the default role");
            }
            let deleted = self.store.delete_role(name).await?;
            self.refresh_roles().await?;
            Ok(deleted)
        }
        .await;
        self.record(actor, "role.delete", name, json!({}), result.is_ok())
            .await;
        result
    }

    /// Assigns `role` to `account` in `scope`, replacing the same assignment.
    pub async fn assign(
        &self,
        actor: &str,
        account: &AccountRef,
        role: &str,
        scope: AuthScope,
    ) -> anyhow::Result<()> {
        let assignment = RoleAssignment {
            account: account.clone(),
            role: role.to_owned(),
            scope,
            granted_by: actor.to_owned(),
            at: Utc::now(),
        };
        let result = async {
            self.require_role(role)?;
            self.store.assign(&assignment).await?;
            self.refresh_account(account).await
        }
        .await;
        let detail = json!({ "role": role, "scope": assignment.scope });
        self.record(
            actor,
            "role.assign",
            &account_str(account),
            detail,
            result.is_ok(),
        )
        .await;
        result
    }

    pub async fn revoke(
        &self,
        actor: &str,
        account: &AccountRef,
        role: &str,
        scope: &AuthScope,
    ) -> anyhow::Result<bool> {
        let result = async {
            let removed = self.store.revoke(account, role, scope).await?;
            self.refresh_account(account).await?;
            Ok(removed)
        }
        .await;
        let detail = json!({ "role": role, "scope": scope });
        self.record(
            actor,
            "role.revoke",
            &account_str(account),
            detail,
            result.is_ok(),
        )
        .await;
        result
    }

    /// Maps a platform role to a Miyoria role in one guild, replacing any
    /// previous mapping of that platform role.
    pub async fn map_role(&self, actor: &str, mapping: RoleMapping) -> anyhow::Result<()> {
        let result = async {
            self.require_role(&mapping.role)?;
            self.store.set_mapping(&mapping).await?;
            self.load_mappings((mapping.platform.clone(), mapping.guild.clone()))
                .await
                .map(drop)
        }
        .await;
        let target = format!("{}:{}", mapping.platform, mapping.guild);
        self.record(actor, "role.map", &target, json!(mapping), result.is_ok())
            .await;
        result
    }

    pub async fn unmap_role(
        &self,
        actor: &str,
        platform: &PlatformId,
        guild: &str,
        platform_role: &str,
    ) -> anyhow::Result<bool> {
        let result = async {
            let removed = self
                .store
                .remove_mapping(platform, guild, platform_role)
                .await?;
            self.load_mappings((platform.clone(), guild.to_owned()))
                .await?;
            Ok(removed)
        }
        .await;
        let target = format!("{platform}:{guild}");
        let detail = json!({ "platform_role": platform_role });
        self.record(actor, "role.unmap", &target, detail, result.is_ok())
            .await;
        result
    }

    /// Allows or denies a node (or pattern) for a role in one scope.
    pub async fn set_override(
        &self,
        actor: &str,
        node_override: NodeOverride,
    ) -> anyhow::Result<()> {
        let result = async {
            self.require_role(&node_override.role)?;
            if !is_valid_pattern(&node_override.node) {
                anyhow::bail!("invalid permission node `{}`", node_override.node);
            }
            self.store.set_override(&node_override).await?;
            self.refresh_overrides().await
        }
        .await;
        self.record(
            actor,
            "perm.set",
            &node_override.role,
            json!(node_override),
            result.is_ok(),
        )
        .await;
        result
    }

    pub async fn remove_override(
        &self,
        actor: &str,
        scope: &AuthScope,
        role: &str,
        node: &str,
    ) -> anyhow::Result<bool> {
        let result = async {
            let removed = self.store.remove_override(scope, role, node).await?;
            self.refresh_overrides().await?;
            Ok(removed)
        }
        .await;
        let detail = json!({ "scope": scope, "node": node });
        self.record(actor, "perm.remove", role, detail, result.is_ok())
            .await;
        result
    }

    fn require_role(&self, role: &str) -> anyhow::Result<()> {
        if self.state.read().roles.contains_key(role) {
            Ok(())
        } else {
            anyhow::bail!("unknown role `{role}`")
        }
    }

    async fn refresh_roles(&self) -> anyhow::Result<()> {
        let roles = self.store.roles().await?;
        self.state.write().roles = roles.into_iter().map(|r| (r.name.clone(), r)).collect();
        Ok(())
    }

    async fn refresh_account(&self, account: &AccountRef) -> anyhow::Result<()> {
        let assignments = self.store.assignments_for(account).await?;
        let mut state = self.state.write();
        if assignments.is_empty() {
            state.assignments.remove(account);
        } else {
            state.assignments.insert(account.clone(), assignments);
        }
        Ok(())
    }

    async fn refresh_overrides(&self) -> anyhow::Result<()> {
        let overrides = self.store.overrides().await?;
        self.state.write().overrides = overrides;
        Ok(())
    }

    async fn record(
        &self,
        actor: &str,
        action: &str,
        target: &str,
        detail: serde_json::Value,
        ok: bool,
    ) {
        let Some(log) = &self.audit else {
            return;
        };
        let entry = AuditEntry {
            id: Ulid::new(),
            at: Utc::now(),
            actor: actor.to_owned(),
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

impl Authorizer for AuthService {
    fn allows_subject(&self, subject: &Subject, node: &str) -> bool {
        self.check(subject, node)
    }
}

#[cfg(feature = "commands")]
#[async_trait::async_trait]
impl miyoria_commands::AuthorizerPreload for AuthService {
    async fn preload(&self, subject: &Subject) {
        AuthService::preload(self, subject).await;
    }
}

/// `"platform:id"`.
pub fn account_str(account: &AccountRef) -> String {
    format!("{}:{}", account.platform, account.id)
}

fn validate_role_name(name: &str) -> anyhow::Result<()> {
    let len = name.chars().count();
    if (1..=MAX_ROLE_NAME).contains(&len)
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        Ok(())
    } else {
        anyhow::bail!("invalid role name `{name}` (1-{MAX_ROLE_NAME} of a-z 0-9 _ -)")
    }
}
