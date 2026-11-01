use std::collections::BTreeMap;

use miyoria_types::{AccountRef, ContextKey, Subject};
use serde::{Deserialize, Serialize};

/// Declares one command. Platforms map it to their own syntax, e.g. Discord
/// turns `["admin", "module", "list"]` into `/admin module list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandSpec {
    /// One to three lowercase words, e.g. `["admin", "module", "list"]`.
    pub path: Vec<String>,
    pub description: String,
    pub args: Vec<ArgSpec>,
    /// Permission node, e.g. `"admin.module.toggle"`. See [`Role::required_for`](crate::Role::required_for).
    pub permission: String,
    /// Default visibility of the reply. Used when a platform must acknowledge
    /// the command before the handler finished (e.g. Discord deferral).
    pub ephemeral: bool,
}

impl CommandSpec {
    /// `path` is space separated, e.g. `"admin module list"`.
    pub fn new(path: &str, description: impl Into<String>) -> Self {
        Self {
            path: path.split_whitespace().map(str::to_owned).collect(),
            description: description.into(),
            args: Vec::new(),
            permission: String::new(),
            ephemeral: false,
        }
    }

    pub fn arg(mut self, arg: ArgSpec) -> Self {
        self.args.push(arg);
        self
    }

    pub fn permission(mut self, node: impl Into<String>) -> Self {
        self.permission = node.into();
        self
    }

    pub fn ephemeral(mut self, ephemeral: bool) -> Self {
        self.ephemeral = ephemeral;
        self
    }

    /// The path joined with spaces.
    pub fn name(&self) -> String {
        self.path.join(" ")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArgSpec {
    pub name: String,
    pub description: String,
    pub kind: ArgKind,
    pub required: bool,
}

impl ArgSpec {
    pub fn new(name: impl Into<String>, description: impl Into<String>, kind: ArgKind) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            kind,
            required: true,
        }
    }

    pub fn optional(mut self) -> Self {
        self.required = false;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "choices", rename_all = "snake_case")]
pub enum ArgKind {
    String,
    Integer,
    Boolean,
    /// A string restricted to one of the listed values.
    Choice(Vec<String>),
    /// A platform account id (Discord: user option). Text mentions such as
    /// `<@123>` are reduced to the id.
    User,
    /// A platform role id (Discord: role option). Text mentions such as
    /// `<@&123>` are reduced to the id.
    Role,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArgValue {
    String(String),
    Integer(i64),
    Boolean(bool),
}

/// One command call, normalized by the platform that received it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invocation {
    pub path: Vec<String>,
    pub args: BTreeMap<String, ArgValue>,
    pub invoker: AccountRef,
    pub invoker_display_name: String,
    pub context: ContextKey,
    /// The invoker administers the guild / server the command was sent in.
    pub invoker_is_guild_admin: bool,
    /// Platform role ids (e.g. Discord role ids) of the invoker in that guild.
    #[serde(default)]
    pub platform_roles: Vec<String>,
    /// What the platform knows about accounts passed in [`ArgKind::User`]
    /// arguments, keyed by account id.
    #[serde(default)]
    pub resolved_users: BTreeMap<String, ResolvedUser>,
}

/// Guild membership details of a user passed as an argument.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedUser {
    pub display_name: String,
    pub platform_roles: Vec<String>,
    pub is_guild_admin: bool,
}

impl Invocation {
    /// An invocation without arguments or guild details. `path` is space
    /// separated.
    pub fn new(path: &str, invoker: AccountRef, context: ContextKey) -> Self {
        Self {
            path: path.split_whitespace().map(str::to_owned).collect(),
            args: BTreeMap::new(),
            invoker_display_name: invoker.id.clone(),
            invoker,
            context,
            invoker_is_guild_admin: false,
            platform_roles: Vec::new(),
            resolved_users: BTreeMap::new(),
        }
    }

    pub fn with_arg(mut self, name: impl Into<String>, value: ArgValue) -> Self {
        self.args.insert(name.into(), value);
        self
    }

    /// The invoker as an authorization subject in the invocation's context.
    pub fn subject(&self) -> Subject {
        Subject {
            account: self.invoker.clone(),
            context: Some(self.context.clone()),
            platform_roles: self.platform_roles.clone(),
            is_guild_admin: self.invoker_is_guild_admin,
        }
    }

    /// `account` as a subject in this context, using the platform's details
    /// from [`resolved_users`](Self::resolved_users) (or the invoker's own).
    pub fn subject_for(&self, account: &AccountRef) -> Subject {
        if account == &self.invoker {
            return self.subject();
        }
        let resolved = (account.platform == self.context.platform)
            .then(|| self.resolved_users.get(&account.id))
            .flatten();
        Subject {
            account: account.clone(),
            context: Some(self.context.clone()),
            platform_roles: resolved
                .map(|r| r.platform_roles.clone())
                .unwrap_or_default(),
            is_guild_admin: resolved.is_some_and(|r| r.is_guild_admin),
        }
    }

    /// An [`ArgKind::User`] argument as an account. Bare ids belong to the
    /// invoker's platform; `"platform:id"` names another one.
    pub fn account(&self, name: &str) -> Option<AccountRef> {
        let raw = self.str(name)?.trim();
        if raw.is_empty() {
            return None;
        }
        Some(match raw.split_once(':') {
            Some((platform, id)) if !platform.is_empty() && !id.is_empty() => AccountRef {
                platform: miyoria_types::PlatformId::new(platform),
                id: id.to_owned(),
            },
            _ => AccountRef {
                platform: self.invoker.platform.clone(),
                id: raw.to_owned(),
            },
        })
    }

    pub fn str(&self, name: &str) -> Option<&str> {
        match self.args.get(name) {
            Some(ArgValue::String(s)) => Some(s),
            _ => None,
        }
    }

    pub fn int(&self, name: &str) -> Option<i64> {
        match self.args.get(name) {
            Some(ArgValue::Integer(i)) => Some(*i),
            _ => None,
        }
    }

    pub fn bool(&self, name: &str) -> Option<bool> {
        match self.args.get(name) {
            Some(ArgValue::Boolean(b)) => Some(*b),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandReply {
    pub text: String,
    /// Only the invoker sees the reply, where the platform supports it.
    pub ephemeral: bool,
}

impl CommandReply {
    pub fn public(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ephemeral: false,
        }
    }

    pub fn ephemeral(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ephemeral: true,
        }
    }
}
