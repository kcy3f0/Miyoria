//! In-memory [`AuthStore`] and [`AuditLog`] for tests.

use async_trait::async_trait;
use miyoria_store::{
    AuditEntry, AuditLog, AuthScope, AuthStore, NodeOverride, RoleAssignment, RoleDefinition,
    RoleMapping,
};
use miyoria_types::{AccountRef, PlatformId};
use parking_lot::Mutex;

#[derive(Default)]
pub struct FakeAuthStore {
    pub roles: Mutex<Vec<RoleDefinition>>,
    pub assignments: Mutex<Vec<RoleAssignment>>,
    pub mappings: Mutex<Vec<RoleMapping>>,
    pub overrides: Mutex<Vec<NodeOverride>>,
}

#[async_trait]
impl AuthStore for FakeAuthStore {
    async fn roles(&self) -> anyhow::Result<Vec<RoleDefinition>> {
        Ok(self.roles.lock().clone())
    }

    async fn upsert_role(&self, role: &RoleDefinition) -> anyhow::Result<()> {
        let mut roles = self.roles.lock();
        roles.retain(|r| r.name != role.name);
        roles.push(role.clone());
        Ok(())
    }

    async fn delete_role(&self, name: &str) -> anyhow::Result<bool> {
        let mut roles = self.roles.lock();
        let before = roles.len();
        roles.retain(|r| r.name != name);
        Ok(roles.len() != before)
    }

    async fn assignments_for(&self, account: &AccountRef) -> anyhow::Result<Vec<RoleAssignment>> {
        Ok(self
            .assignments
            .lock()
            .iter()
            .filter(|a| &a.account == account)
            .cloned()
            .collect())
    }

    async fn all_assignments(&self) -> anyhow::Result<Vec<RoleAssignment>> {
        Ok(self.assignments.lock().clone())
    }

    async fn assign(&self, assignment: &RoleAssignment) -> anyhow::Result<()> {
        let mut all = self.assignments.lock();
        all.retain(|a| {
            !(a.account == assignment.account
                && a.role == assignment.role
                && a.scope == assignment.scope)
        });
        all.push(assignment.clone());
        Ok(())
    }

    async fn revoke(
        &self,
        account: &AccountRef,
        role: &str,
        scope: &AuthScope,
    ) -> anyhow::Result<bool> {
        let mut all = self.assignments.lock();
        let before = all.len();
        all.retain(|a| !(&a.account == account && a.role == role && &a.scope == scope));
        Ok(all.len() != before)
    }

    async fn mappings(
        &self,
        platform: &PlatformId,
        guild: &str,
    ) -> anyhow::Result<Vec<RoleMapping>> {
        Ok(self
            .mappings
            .lock()
            .iter()
            .filter(|m| &m.platform == platform && m.guild == guild)
            .cloned()
            .collect())
    }

    async fn set_mapping(&self, mapping: &RoleMapping) -> anyhow::Result<()> {
        let mut all = self.mappings.lock();
        all.retain(|m| {
            !(m.platform == mapping.platform
                && m.guild == mapping.guild
                && m.platform_role == mapping.platform_role)
        });
        all.push(mapping.clone());
        Ok(())
    }

    async fn remove_mapping(
        &self,
        platform: &PlatformId,
        guild: &str,
        platform_role: &str,
    ) -> anyhow::Result<bool> {
        let mut all = self.mappings.lock();
        let before = all.len();
        all.retain(|m| {
            !(&m.platform == platform && m.guild == guild && m.platform_role == platform_role)
        });
        Ok(all.len() != before)
    }

    async fn overrides(&self) -> anyhow::Result<Vec<NodeOverride>> {
        Ok(self.overrides.lock().clone())
    }

    async fn set_override(&self, node_override: &NodeOverride) -> anyhow::Result<()> {
        let mut all = self.overrides.lock();
        all.retain(|o| {
            !(o.scope == node_override.scope
                && o.role == node_override.role
                && o.node == node_override.node)
        });
        all.push(node_override.clone());
        Ok(())
    }

    async fn remove_override(
        &self,
        scope: &AuthScope,
        role: &str,
        node: &str,
    ) -> anyhow::Result<bool> {
        let mut all = self.overrides.lock();
        let before = all.len();
        all.retain(|o| !(&o.scope == scope && o.role == role && o.node == node));
        Ok(all.len() != before)
    }
}

#[derive(Default)]
pub struct FakeAudit {
    pub entries: Mutex<Vec<AuditEntry>>,
}

impl FakeAudit {
    pub fn actions(&self) -> Vec<(String, bool)> {
        self.entries
            .lock()
            .iter()
            .map(|e| (e.action.clone(), e.ok))
            .collect()
    }
}

#[async_trait]
impl AuditLog for FakeAudit {
    async fn append(&self, entry: &AuditEntry) -> anyhow::Result<()> {
        self.entries.lock().push(entry.clone());
        Ok(())
    }

    async fn recent(&self, limit: usize, actor: Option<&str>) -> anyhow::Result<Vec<AuditEntry>> {
        Ok(self
            .entries
            .lock()
            .iter()
            .rev()
            .filter(|e| actor.is_none_or(|a| e.actor == a))
            .take(limit)
            .cloned()
            .collect())
    }
}
