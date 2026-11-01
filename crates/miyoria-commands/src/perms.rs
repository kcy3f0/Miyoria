//! Phase-1 permissions: three fixed roles derived from the permission node
//! prefix. Replaced by `miyoria-auth` RBAC later.

use std::collections::HashSet;

use miyoria_types::{AccountRef, PlatformId};

use crate::spec::Invocation;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    User,
    /// Owner or guild administrator.
    Admin,
    /// Listed in `[modules.commands] owners`.
    Owner,
}

impl Role {
    /// `owner.*` needs [`Role::Owner`], `admin.*` needs [`Role::Admin`],
    /// everything else [`Role::User`].
    pub fn required_for(permission: &str) -> Self {
        let root = permission.split('.').next().unwrap_or_default();
        match root {
            "owner" => Self::Owner,
            "admin" => Self::Admin,
            _ => Self::User,
        }
    }
}

/// Resolves the role of an invoker.
#[derive(Clone, Debug, Default)]
pub struct Permissions {
    owners: HashSet<AccountRef>,
}

impl Permissions {
    pub fn new(owners: impl IntoIterator<Item = AccountRef>) -> Self {
        Self {
            owners: owners.into_iter().collect(),
        }
    }

    /// Parses `"platform:id"` strings such as `"discord:123"`.
    pub fn from_strings<S: AsRef<str>>(owners: &[S]) -> anyhow::Result<Self> {
        let owners = owners
            .iter()
            .map(|s| parse_account(s.as_ref()))
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(Self::new(owners))
    }

    pub fn is_owner(&self, account: &AccountRef) -> bool {
        self.owners.contains(account)
    }

    pub fn role_of(&self, invocation: &Invocation) -> Role {
        if self.is_owner(&invocation.invoker) {
            Role::Owner
        } else if invocation.invoker_is_guild_admin {
            Role::Admin
        } else {
            Role::User
        }
    }

    pub fn allows(&self, invocation: &Invocation, permission: &str) -> bool {
        self.role_of(invocation) >= Role::required_for(permission)
    }
}

/// Parses `"platform:id"` into an [`AccountRef`].
pub fn parse_account(s: &str) -> anyhow::Result<AccountRef> {
    match s.trim().split_once(':') {
        Some((platform, id)) if !platform.is_empty() && !id.is_empty() => Ok(AccountRef {
            platform: PlatformId::new(platform),
            id: id.to_owned(),
        }),
        _ => anyhow::bail!("invalid account `{s}`, expected `platform:id`"),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use miyoria_types::{ContextKey, ContextKind};

    use super::*;

    fn inv(id: &str, guild_admin: bool) -> Invocation {
        Invocation {
            path: vec!["x".into()],
            args: BTreeMap::new(),
            invoker: parse_account(&format!("discord:{id}")).unwrap(),
            invoker_display_name: "someone".into(),
            context: ContextKey {
                platform: PlatformId::new("discord"),
                scope: Some("1".into()),
                channel: "2".into(),
                kind: ContextKind::Channel,
            },
            invoker_is_guild_admin: guild_admin,
        }
    }

    #[test]
    fn required_roles() {
        assert_eq!(Role::required_for("admin.module.toggle"), Role::Admin);
        assert_eq!(Role::required_for("owner.shutdown"), Role::Owner);
        assert_eq!(Role::required_for("memory.forget.self"), Role::User);
        assert_eq!(Role::required_for("administrator"), Role::User);
        assert_eq!(Role::required_for(""), Role::User);
    }

    #[test]
    fn roles_and_checks() {
        let perms = Permissions::from_strings(&["discord:1"]).unwrap();
        let owner = inv("1", false);
        let admin = inv("2", true);
        let user = inv("3", false);
        assert_eq!(perms.role_of(&owner), Role::Owner);
        assert_eq!(perms.role_of(&admin), Role::Admin);
        assert_eq!(perms.role_of(&user), Role::User);

        assert!(perms.allows(&owner, "owner.x"));
        assert!(perms.allows(&owner, "admin.x"));
        assert!(!perms.allows(&admin, "owner.x"));
        assert!(perms.allows(&admin, "admin.x"));
        assert!(!perms.allows(&user, "admin.x"));
        assert!(perms.allows(&user, "chat"));
    }

    #[test]
    fn owner_ids_are_platform_scoped() {
        let perms = Permissions::from_strings(&["twitch:1"]).unwrap();
        assert!(!perms.is_owner(&inv("1", false).invoker));
        assert!(parse_account("discord").is_err());
        assert!(parse_account("discord:").is_err());
    }
}
