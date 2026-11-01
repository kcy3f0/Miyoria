//! Platform-agnostic command framework.
//!
//! Commands are declared once as a [`CommandSpec`] with an async handler and
//! registered in the [`CommandRegistry`], which the `commands` module provides
//! as a service. Platform adapters map specs to their own syntax (Discord
//! slash commands, chat `!cmd`, CLI, panel), turn calls into an
//! [`Invocation`] and send back the [`CommandReply`].
//!
//! Permission checks use the `dyn Authorizer` service (the `auth` module's
//! RBAC) when it is available. Without it, three fallback roles apply (see
//! [`Role`]): nodes starting with `owner.` need an owner, `admin.` an owner or
//! guild admin, everything else is open to every user. Commands with
//! `admin.*` / `owner.*` nodes are written to the `dyn AuditLog` service when
//! there is one.

pub mod module;
pub mod perms;
pub mod registry;
pub mod spec;

pub use module::{CommandsConfig, CommandsModule, register_builtins};
pub use perms::{Permissions, Role, parse_account};
pub use registry::{
    AuthorizerPreload, CommandRegistry, HandlerFuture, MAX_PATH_DEPTH, normalize_args,
};
pub use spec::{ArgKind, ArgSpec, ArgValue, CommandReply, CommandSpec, Invocation, ResolvedUser};
