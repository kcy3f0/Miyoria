//! Built-in roles. See the crate docs for the table.

use miyoria_store::RoleDefinition;

pub const OWNER: &str = "owner";
pub const ADMIN: &str = "admin";
pub const MODERATOR: &str = "moderator";
pub const TRUSTED: &str = "trusted";
pub const USER: &str = "user";
pub const RESTRICTED: &str = "restricted";
pub const BLOCKED: &str = "blocked";

/// Roles at or below this rank are "blocked": an explicit assignment of one
/// beats every other role source except config owners, and such roles may
/// not use commands without a permission node.
pub const BLOCKED_RANK: i32 = 0;

/// Self-service privacy controls; kept even for `restricted`.
const PRIVACY: &[&str] = &[
    "ping",
    "help.*",
    "me.*",
    "memory.self.*",
    "memory.show.self",
    "memory.forget.self",
    "memory.export.self",
    "voice.consent",
];

const EVERYDAY: &[&str] = &[
    "chat.talk",
    "link.*",
    "voice.join",
    "voice.leave",
    "queue.request",
    "queue.list",
    "game.status",
    "stream.status",
];

const TRUSTED_EXTRA: &[&str] = &[
    "chat.*",
    "tools.*",
    "queue.priority",
    "game.suggest",
    "stream.clip",
];

const MODERATOR_EXTRA: &[&str] = &[
    "voice.*",
    "queue.*",
    "game.*",
    "stream.scene",
    "memory.view.others",
    "admin.channel.*",
    "admin.voice.*",
    "admin.block.*",
    "admin.persona.view",
    "admin.role.list",
    "admin.role.whois",
    "admin.audit.view",
];

const ADMIN_EXTRA: &[&str] = &["admin.*", "module.*", "memory.*", "stream.*"];

/// MCP tools can do anything their server can; below admin they need an
/// explicit override.
const NO_MCP: &[&str] = &["tools.mcp.*"];

fn role(name: &str, rank: i32, grants: &[&[&str]], denies: &[&str]) -> RoleDefinition {
    RoleDefinition {
        name: name.to_owned(),
        rank,
        grants: grants
            .iter()
            .flat_map(|g| g.iter())
            .map(|s| (*s).to_owned())
            .collect(),
        denies: denies.iter().map(|s| (*s).to_owned()).collect(),
        builtin: true,
    }
}

/// The seven built-in roles, highest rank first. Each lists all of its
/// nodes; roles do not inherit from each other.
pub fn builtin_roles() -> Vec<RoleDefinition> {
    let user: &[&[&str]] = &[PRIVACY, EVERYDAY];
    let trusted: &[&[&str]] = &[PRIVACY, EVERYDAY, TRUSTED_EXTRA];
    let moderator: &[&[&str]] = &[PRIVACY, EVERYDAY, TRUSTED_EXTRA, MODERATOR_EXTRA];
    let admin: &[&[&str]] = &[
        PRIVACY,
        EVERYDAY,
        TRUSTED_EXTRA,
        MODERATOR_EXTRA,
        ADMIN_EXTRA,
    ];
    vec![
        role(OWNER, 100, &[&["*"]], &[]),
        role(ADMIN, 80, admin, &[]),
        role(MODERATOR, 60, moderator, NO_MCP),
        role(TRUSTED, 40, trusted, NO_MCP),
        role(USER, 20, user, &[]),
        role(RESTRICTED, 10, &[PRIVACY], &[]),
        role(BLOCKED, BLOCKED_RANK, &[], &[]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::{is_valid_pattern, matches};

    fn allows(role: &RoleDefinition, node: &str) -> bool {
        !role.denies.iter().any(|p| matches(p, node))
            && role.grants.iter().any(|p| matches(p, node))
    }

    #[test]
    fn builtins_are_ordered_and_valid() {
        let roles = builtin_roles();
        assert_eq!(roles.len(), 7);
        assert!(roles.windows(2).all(|w| w[0].rank > w[1].rank));
        for r in &roles {
            for p in r.grants.iter().chain(&r.denies) {
                assert!(is_valid_pattern(p), "{}: {p}", r.name);
            }
        }
    }

    #[test]
    fn builtin_nodes() {
        let roles = builtin_roles();
        let get = |n: &str| roles.iter().find(|r| r.name == n).unwrap();
        assert!(allows(get(OWNER), "owner.shutdown"));
        assert!(!allows(get(ADMIN), "owner.shutdown"));
        assert!(allows(get(ADMIN), "admin.module.toggle"));
        assert!(allows(get(ADMIN), "tools.mcp.fs.write"));
        assert!(!allows(get(MODERATOR), "tools.mcp.fs.write"));
        assert!(allows(get(MODERATOR), "admin.channel.mode"));
        assert!(!allows(get(MODERATOR), "admin.module.toggle"));
        assert!(allows(get(TRUSTED), "tools.web.search"));
        assert!(allows(get(USER), "voice.join"));
        assert!(allows(get(USER), "ping"));
        assert!(!allows(get(USER), "queue.skip"));
        assert!(!allows(get(USER), "admin.channel.mode"));
        assert!(allows(get(RESTRICTED), "memory.forget.self"));
        assert!(allows(get(RESTRICTED), "voice.consent"));
        assert!(!allows(get(RESTRICTED), "voice.join"));
        assert!(!allows(get(BLOCKED), "ping"));
    }
}
