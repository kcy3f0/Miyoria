use std::collections::BTreeMap;

use miyoria_types::{AccountRef, ContextKey};
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
}

impl Invocation {
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
