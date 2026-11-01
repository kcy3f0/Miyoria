//! Pure role resolution and node checks over a cached snapshot of the
//! [`AuthStore`](miyoria_store::AuthStore).

use std::collections::{HashMap, HashSet};

use miyoria_store::{AuthScope, NodeOverride, RoleAssignment, RoleDefinition, RoleMapping};
use miyoria_types::{AccountRef, ContextKey, PlatformId, Subject};
use serde::Serialize;

use crate::builtin::{ADMIN, BLOCKED_RANK, OWNER};
use crate::node::matches;

/// `(platform, guild id)`.
pub type GuildKey = (PlatformId, String);

/// Why a subject may hold a role.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Source {
    /// Listed in `[modules.auth] owners` (or `[modules.commands] owners`).
    ConfigOwner,
    Assignment {
        scope: AuthScope,
        granted_by: String,
    },
    /// A platform role (e.g. Discord role id) mapped in this guild.
    PlatformRole { platform_role: String },
    /// Platform-level administrator of the guild; at least `admin`.
    GuildAdmin,
    /// Nothing else applied.
    Default,
}

impl Source {
    /// Breaks rank ties: more specific sources win.
    fn specificity(&self) -> u8 {
        match self {
            Self::ConfigOwner => 4,
            Self::Assignment {
                scope: AuthScope::Channel { .. },
                ..
            } => 3,
            Self::Assignment {
                scope: AuthScope::Guild { .. },
                ..
            }
            | Self::PlatformRole { .. }
            | Self::GuildAdmin => 2,
            Self::Assignment {
                scope: AuthScope::Global,
                ..
            } => 1,
            Self::Default => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Candidate {
    pub role: String,
    pub rank: i32,
    pub source: Source,
}

/// The effective role of a subject and every role that applied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Resolution {
    pub effective: Candidate,
    /// All applicable roles, best first (includes `effective`).
    pub candidates: Vec<Candidate>,
    /// The guild's platform role mappings were not cached yet and were
    /// ignored.
    pub mappings_missing: bool,
}

impl Resolution {
    pub fn is_config_owner(&self) -> bool {
        self.effective.source == Source::ConfigOwner
    }

    /// May this subject manage something at `rank` (assign that role, edit
    /// someone holding it)? Config owners may manage everything, everyone
    /// else only strictly lower ranks.
    pub fn outranks(&self, rank: i32) -> bool {
        self.is_config_owner() || rank < self.effective.rank
    }
}

/// Everything the authorizer needs, cached from the store.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub roles: HashMap<String, RoleDefinition>,
    pub assignments: HashMap<AccountRef, Vec<RoleAssignment>>,
    pub overrides: Vec<NodeOverride>,
    /// Per guild; guilds not in the map have not been loaded yet.
    pub mappings: HashMap<GuildKey, Vec<RoleMapping>>,
    pub owners: HashSet<AccountRef>,
    pub default_role: String,
}

impl Snapshot {
    pub fn set_assignments(&mut self, all: Vec<RoleAssignment>) {
        self.assignments.clear();
        for a in all {
            self.assignments
                .entry(a.account.clone())
                .or_default()
                .push(a);
        }
    }

    fn candidate(&self, role: &str, source: Source) -> Option<Candidate> {
        self.roles.get(role).map(|r| Candidate {
            role: r.name.clone(),
            rank: r.rank,
            source,
        })
    }

    /// Resolves the effective role:
    ///
    /// 1. config owners → `owner`;
    /// 2. explicit assignments whose scope covers the subject's context;
    /// 3. platform role mappings of the subject's guild;
    /// 4. guild admins → `admin`;
    /// 5. nothing applied → the default role (`user`).
    ///
    /// The highest rank wins (ties: the more specific source), except that an
    /// explicit assignment of a blocked role (rank ≤ 0) beats everything but
    /// config owners.
    pub fn resolve(&self, subject: &Subject) -> Resolution {
        let ctx = subject.context.as_ref();
        let mut candidates = Vec::new();
        if self.owners.contains(&subject.account) {
            candidates.push(Candidate {
                role: OWNER.to_owned(),
                rank: self.roles.get(OWNER).map_or(100, |r| r.rank),
                source: Source::ConfigOwner,
            });
        }
        for a in self.assignments.get(&subject.account).into_iter().flatten() {
            if scope_covers(&a.scope, ctx) {
                candidates.extend(self.candidate(
                    &a.role,
                    Source::Assignment {
                        scope: a.scope.clone(),
                        granted_by: a.granted_by.clone(),
                    },
                ));
            }
        }
        let mut mappings_missing = false;
        if let Some(guild) = guild_of(ctx) {
            match self.mappings.get(&guild) {
                Some(maps) => {
                    for m in maps {
                        if subject.platform_roles.contains(&m.platform_role) {
                            candidates.extend(self.candidate(
                                &m.role,
                                Source::PlatformRole {
                                    platform_role: m.platform_role.clone(),
                                },
                            ));
                        }
                    }
                }
                None => mappings_missing = !subject.platform_roles.is_empty(),
            }
        }
        if subject.is_guild_admin {
            candidates.extend(self.candidate(ADMIN, Source::GuildAdmin));
        }
        if candidates.is_empty() {
            candidates.push(
                self.candidate(&self.default_role, Source::Default)
                    .unwrap_or(Candidate {
                        role: self.default_role.clone(),
                        rank: BLOCKED_RANK,
                        source: Source::Default,
                    }),
            );
        }
        candidates.sort_by(|a, b| {
            (b.rank, b.source.specificity())
                .cmp(&(a.rank, a.source.specificity()))
                .then_with(|| a.role.cmp(&b.role))
        });
        let blocked = candidates
            .iter()
            .find(|c| c.rank <= BLOCKED_RANK && matches!(c.source, Source::Assignment { .. }));
        let effective = match (candidates.first(), blocked) {
            (Some(first), _) if first.source == Source::ConfigOwner => first.clone(),
            (_, Some(blocked)) => blocked.clone(),
            (Some(first), None) => first.clone(),
            (None, None) => unreachable!("candidates always has the default role"),
        };
        Resolution {
            effective,
            candidates,
            mappings_missing,
        }
    }

    /// May `subject`, resolved as `resolution`, use `node`?
    ///
    /// Config owners may use everything. Otherwise the effective role's
    /// overrides are checked from the most specific scope that has a
    /// matching one (channel > guild > global), then the role's own lists.
    /// Within one level a deny beats a grant. The empty node ("no permission
    /// needed") is open to every role above the blocked rank.
    pub fn check(&self, subject: &Subject, resolution: &Resolution, node: &str) -> bool {
        if resolution.is_config_owner() {
            return true;
        }
        let role = &resolution.effective.role;
        if node.is_empty() {
            return resolution.effective.rank > BLOCKED_RANK && self.roles.contains_key(role);
        }
        let ctx = subject.context.as_ref();
        for level in [Level::Channel, Level::Guild, Level::Global] {
            let mut allowed = None;
            for o in &self.overrides {
                if &o.role == role
                    && level.of(&o.scope)
                    && scope_covers(&o.scope, ctx)
                    && matches(&o.node, node)
                {
                    allowed = Some(allowed.unwrap_or(true) && o.allow);
                }
            }
            if let Some(allowed) = allowed {
                return allowed;
            }
        }
        let Some(def) = self.roles.get(role) else {
            return false;
        };
        !def.denies.iter().any(|p| matches(p, node)) && def.grants.iter().any(|p| matches(p, node))
    }
}

#[derive(Clone, Copy)]
enum Level {
    Channel,
    Guild,
    Global,
}

impl Level {
    fn of(self, scope: &AuthScope) -> bool {
        matches!(
            (self, scope),
            (Self::Channel, AuthScope::Channel { .. })
                | (Self::Guild, AuthScope::Guild { .. })
                | (Self::Global, AuthScope::Global)
        )
    }
}

pub fn guild_of(ctx: Option<&ContextKey>) -> Option<GuildKey> {
    let ctx = ctx?;
    Some((ctx.platform.clone(), ctx.scope.clone()?))
}

/// Same platform, guild and channel id; the context kind is ignored, so a
/// channel scope also covers the channel's threads-as-channel and voice chat.
fn same_channel(a: &ContextKey, b: &ContextKey) -> bool {
    a.platform == b.platform && a.scope == b.scope && a.channel == b.channel
}

/// Does `scope` apply in `ctx`? Global always does; guild and channel scopes
/// need a matching context.
pub fn scope_covers(scope: &AuthScope, ctx: Option<&ContextKey>) -> bool {
    match scope {
        AuthScope::Global => true,
        AuthScope::Guild { platform, guild } => {
            ctx.is_some_and(|c| &c.platform == platform && c.scope.as_deref() == Some(guild))
        }
        AuthScope::Channel { context } => ctx.is_some_and(|c| same_channel(c, context)),
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use miyoria_types::ContextKind;

    use super::*;
    use crate::builtin::{BLOCKED, MODERATOR, RESTRICTED, TRUSTED, USER, builtin_roles};

    fn acc(id: &str) -> AccountRef {
        AccountRef {
            platform: PlatformId::new("discord"),
            id: id.into(),
        }
    }

    fn ctx(guild: &str, channel: &str) -> ContextKey {
        ContextKey {
            platform: PlatformId::new("discord"),
            scope: Some(guild.into()),
            channel: channel.into(),
            kind: ContextKind::Channel,
        }
    }

    fn guild(g: &str) -> AuthScope {
        AuthScope::Guild {
            platform: PlatformId::new("discord"),
            guild: g.into(),
        }
    }

    fn subject(id: &str, c: Option<ContextKey>, roles: &[&str], admin: bool) -> Subject {
        Subject {
            account: acc(id),
            context: c,
            platform_roles: roles.iter().map(|s| (*s).to_owned()).collect(),
            is_guild_admin: admin,
        }
    }

    fn assign(id: &str, role: &str, scope: AuthScope) -> RoleAssignment {
        RoleAssignment {
            account: acc(id),
            role: role.into(),
            scope,
            granted_by: "test".into(),
            at: Utc::now(),
        }
    }

    fn snapshot() -> Snapshot {
        let mut s = Snapshot {
            roles: builtin_roles()
                .into_iter()
                .map(|r| (r.name.clone(), r))
                .collect(),
            owners: [acc("1")].into(),
            default_role: USER.into(),
            ..Snapshot::default()
        };
        s.set_assignments(vec![
            assign("2", TRUSTED, AuthScope::Global),
            assign("2", MODERATOR, guild("g1")),
            assign(
                "3",
                MODERATOR,
                AuthScope::Channel {
                    context: ctx("g1", "c1"),
                },
            ),
            assign("4", BLOCKED, guild("g1")),
            assign("5", RESTRICTED, AuthScope::Global),
            assign("6", "ghost", AuthScope::Global),
        ]);
        s.mappings.insert(
            (PlatformId::new("discord"), "g1".into()),
            vec![RoleMapping {
                platform: PlatformId::new("discord"),
                guild: "g1".into(),
                platform_role: "r-mod".into(),
                role: MODERATOR.into(),
            }],
        );
        s
    }

    fn role_of(s: &Snapshot, sub: &Subject) -> String {
        s.resolve(sub).effective.role
    }

    #[test]
    fn resolution_order() {
        let s = snapshot();
        let g1 = Some(ctx("g1", "c1"));
        let g2 = Some(ctx("g2", "c9"));
        // Config owner beats everything, even a guild-admin flag.
        let owner = s.resolve(&subject("1", g1.clone(), &[], true));
        assert_eq!(owner.effective.role, OWNER);
        assert!(owner.is_config_owner());
        // Assignments by scope.
        assert_eq!(
            role_of(&s, &subject("2", g1.clone(), &[], false)),
            MODERATOR
        );
        assert_eq!(role_of(&s, &subject("2", g2.clone(), &[], false)), TRUSTED);
        assert_eq!(role_of(&s, &subject("2", None, &[], false)), TRUSTED);
        assert_eq!(
            role_of(&s, &subject("3", g1.clone(), &[], false)),
            MODERATOR
        );
        assert_eq!(
            role_of(&s, &subject("3", Some(ctx("g1", "c2")), &[], false)),
            USER
        );
        // Platform role mapping only in its guild.
        assert_eq!(
            role_of(&s, &subject("9", g1.clone(), &["r-mod"], false)),
            MODERATOR
        );
        assert_eq!(
            role_of(&s, &subject("9", g2.clone(), &["r-mod"], false)),
            USER
        );
        // Guild admins are at least admin; higher assignments still win.
        assert_eq!(role_of(&s, &subject("9", g1.clone(), &[], true)), ADMIN);
        // Restricted assignment replaces the default.
        assert_eq!(
            role_of(&s, &subject("5", g1.clone(), &[], false)),
            RESTRICTED
        );
        // Unknown roles are ignored.
        assert_eq!(role_of(&s, &subject("6", None, &[], false)), USER);
        let r = s.resolve(&subject("9", None, &[], false));
        assert_eq!(r.effective.source, Source::Default);
    }

    #[test]
    fn explicit_block_beats_guild_admin() {
        let s = snapshot();
        let r = s.resolve(&subject("4", Some(ctx("g1", "c1")), &["r-mod"], true));
        assert_eq!(r.effective.role, BLOCKED);
        assert_eq!(r.candidates.len(), 3);
        assert_eq!(r.candidates[0].role, ADMIN);
        assert_eq!(
            role_of(&s, &subject("4", Some(ctx("g2", "c1")), &[], true)),
            ADMIN
        );
    }

    #[test]
    fn missing_mappings_are_reported() {
        let s = snapshot();
        let r = s.resolve(&subject("9", Some(ctx("g2", "c1")), &["x"], false));
        assert!(r.mappings_missing);
        let r = s.resolve(&subject("9", Some(ctx("g1", "c1")), &["x"], false));
        assert!(!r.mappings_missing);
    }

    fn allowed(s: &Snapshot, sub: &Subject, node: &str) -> bool {
        s.check(sub, &s.resolve(sub), node)
    }

    #[test]
    fn overrides_by_scope() {
        let mut s = snapshot();
        let ov = |scope: AuthScope, role: &str, node: &str, allow: bool| NodeOverride {
            scope,
            role: role.into(),
            node: node.into(),
            allow,
        };
        s.overrides = vec![
            ov(AuthScope::Global, USER, "queue.skip", true),
            ov(guild("g1"), USER, "queue.*", false),
            ov(
                AuthScope::Channel {
                    context: ctx("g1", "c1"),
                },
                USER,
                "queue.skip",
                true,
            ),
            // Same level: deny beats grant.
            ov(guild("g2"), USER, "voice.*", true),
            ov(guild("g2"), USER, "voice.join", false),
        ];
        let at = |g: &str, c: &str| subject("9", Some(ctx(g, c)), &[], false);
        assert!(allowed(&s, &at("g1", "c1"), "queue.skip"));
        assert!(!allowed(&s, &at("g1", "c2"), "queue.skip"));
        assert!(!allowed(&s, &at("g1", "c2"), "queue.request"));
        assert!(allowed(&s, &at("g3", "c2"), "queue.skip"));
        assert!(allowed(&s, &subject("9", None, &[], false), "queue.skip"));
        assert!(!allowed(&s, &at("g2", "c1"), "voice.join"));
        assert!(allowed(&s, &at("g2", "c1"), "voice.mute"));
        // Overrides of other roles do not apply.
        assert!(!allowed(&s, &subject("2", None, &[], false), "voice.mute"));
    }

    #[test]
    fn owners_blocked_and_empty_nodes() {
        let s = snapshot();
        let owner = subject("1", None, &[], false);
        assert!(allowed(&s, &owner, "owner.shutdown"));
        assert!(allowed(&s, &owner, ""));
        let user = subject("9", None, &[], false);
        assert!(allowed(&s, &user, ""));
        assert!(allowed(&s, &user, "ping"));
        assert!(!allowed(&s, &user, "admin.module.toggle"));
        let blocked = subject("4", Some(ctx("g1", "c1")), &[], false);
        assert!(!allowed(&s, &blocked, ""));
        assert!(!allowed(&s, &blocked, "ping"));
        let admin = subject("9", Some(ctx("g1", "c1")), &[], true);
        assert!(allowed(&s, &admin, "admin.module.toggle"));
        assert!(!allowed(&s, &admin, "owner.shutdown"));
    }

    #[test]
    fn outranks() {
        let s = snapshot();
        let owner = s.resolve(&subject("1", None, &[], false));
        assert!(owner.outranks(100));
        let admin = s.resolve(&subject("9", Some(ctx("g1", "c1")), &[], true));
        assert!(admin.outranks(60));
        assert!(!admin.outranks(80));
    }
}
