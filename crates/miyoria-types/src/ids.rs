use std::fmt;

use serde::{Deserialize, Serialize};
use ulid::Ulid;

macro_rules! ulid_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Ulid);

        impl $name {
            pub fn new() -> Self {
                Self(Ulid::new())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }
    };
}

ulid_id!(EventId);
ulid_id!(
    /// Correlates every event, LLM call and action that belongs to one "turn"
    /// of the agent (from perception to output).
    TurnId
);
ulid_id!(ActionId);
ulid_id!(
    /// A cross-platform person. Several platform accounts can link to one person.
    PersonId
);

string_id!(
    /// Stable module identifier, e.g. `"platform.discord.bot"` or `"agent"`.
    ModuleId
);
string_id!(
    /// A profile bundles persona, LLM, voice and avatar, e.g. `"deepseek-chan"`.
    ProfileId
);
