use serde::{Deserialize, Serialize};

use crate::platform::{AccountRef, ContextKey};

/// Who is asking, with as much context as the caller has.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subject {
    pub account: AccountRef,
    /// Where the action happens (guild / channel overrides apply).
    pub context: Option<ContextKey>,
    /// Platform role ids (e.g. Discord role ids) of the account in that guild.
    pub platform_roles: Vec<String>,
    /// Platform-level administrator (e.g. Discord ADMINISTRATOR / MANAGE_GUILD).
    pub is_guild_admin: bool,
}

impl Subject {
    pub fn account(account: AccountRef) -> Self {
        Self {
            account,
            context: None,
            platform_roles: Vec::new(),
            is_guild_admin: false,
        }
    }
}

/// Answers "may this subject use this permission node?". Provided as a
/// `dyn Authorizer` service by the module that owns permissions (`auth`, or
/// `commands` as a fallback). Used for commands, tools and API calls.
pub trait Authorizer: Send + Sync {
    fn allows(&self, account: &AccountRef, node: &str) -> bool {
        self.allows_subject(&Subject::account(account.clone()), node)
    }

    fn allows_subject(&self, subject: &Subject, node: &str) -> bool;
}
