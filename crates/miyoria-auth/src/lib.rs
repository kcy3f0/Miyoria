//! Role-based permissions (module `auth`).
//!
//! Every account has one effective role per context; the role grants
//! permission nodes such as `voice.join` or `admin.module.toggle`. The
//! [`AuthStore`](miyoria_store::AuthStore) is the source of truth;
//! [`AuthService`] caches it and answers `dyn Authorizer` checks
//! synchronously.
//!
//! # Built-in roles
//!
//! Seeded into the store on first start when missing. They can be edited
//! (not deleted), and custom roles can be added. Roles do not inherit: each
//! lists all of its nodes.
//!
//! | Role | Rank | Grants | Denies |
//! |---|---|---|---|
//! | `owner` | 100 | `*` | |
//! | `admin` | 80 | everything below plus `admin.*`, `module.*`, `memory.*`, `stream.*`, `tools.*` | |
//! | `moderator` | 60 | trusted plus `voice.*`, `queue.*`, `game.*`, `stream.scene`, `memory.view.others`, `admin.channel.*`, `admin.voice.*`, `admin.block.*`, `admin.persona.view`, `admin.role.list`, `admin.role.whois`, `admin.audit.view` | `tools.mcp.*` |
//! | `trusted` | 40 | user plus `chat.*`, `tools.*`, `queue.priority`, `game.suggest`, `stream.clip` | `tools.mcp.*` |
//! | `user` | 20 | restricted plus `chat.talk`, `link.*`, `voice.join`, `voice.leave`, `queue.request`, `queue.list`, `game.status`, `stream.status` | |
//! | `restricted` | 10 | `ping`, `help.*`, `me.*`, `memory.self.*`, `memory.show.self`, `memory.forget.self`, `memory.export.self`, `voice.consent` | |
//! | `blocked` | 0 | nothing | |
//!
//! Admin panel nodes ([`builtin::PANEL_ACCESS`], [`builtin::PANEL_WRITE`]):
//!
//! | Node | Allows | Held by default |
//! |---|---|---|
//! | `admin.panel.access` | logging in to the admin panel with Discord and reading it | `owner`, `admin` |
//! | `admin.panel.write` | changes from the panel (every non-`GET` admin API route) | `owner`, `admin` |
//!
//! The panel checks them without a guild or channel, so only global grants
//! count, e.g. `/admin perm allow role:moderator node:admin.panel.access scope:global`.
//!
//! `restricted` keeps the privacy controls (consent, forgetting, export) so
//! nobody loses control over their own data. Whether the agent ignores
//! blocked people is up to the social module; here they are simply denied.
//!
//! # Resolution
//!
//! For a [`Subject`](miyoria_types::Subject), the candidate roles are:
//! config owners (`[modules.auth] owners`) → `owner`; explicit assignments
//! whose scope (global / guild / channel) covers the subject's context;
//! platform role mappings of the subject's guild; guild admins → `admin`.
//! The highest rank wins; with no candidate the default role (`user`)
//! applies. An explicit assignment of a blocked role (rank ≤ 0) beats
//! everything except config owners.
//!
//! A node is then checked against the effective role's overrides in the
//! most specific scope that has a matching one (channel > guild > global),
//! falling back to the role's own lists; at each level a deny beats a grant.
//! Patterns: exact, `prefix.*` (the prefix and everything below), `*`.
//! Config owners may use every node.
//!
//! # Wiring
//!
//! The app provides `Arc<dyn AuthStore>` (required) and `Arc<dyn AuditLog>`
//! (optional) as services and registers [`AuthModule`]. With the default
//! `commands` feature the module also registers the `admin role ...` and
//! `admin perm ...` commands and provides
//! `Arc<dyn miyoria_commands::AuthorizerPreload>` so command checks see the
//! guild's role mappings on first use.

pub mod builtin;
#[cfg(feature = "commands")]
mod commands;
#[cfg(all(test, feature = "commands"))]
mod fake;
mod module;
pub mod node;
pub mod resolve;
mod service;
#[cfg(all(test, feature = "commands"))]
mod tests;

pub use builtin::builtin_roles;
pub use module::{AuthConfig, AuthModule, parse_account};
pub use resolve::{Candidate, Resolution, Source};
pub use service::{AuthService, account_str};
