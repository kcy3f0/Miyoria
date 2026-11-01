use std::sync::Arc;

use miyoria_profile::{PersonaSection, Profile};
use parking_lot::RwLock;

/// Shared, runtime-editable handle to the active profile. Provided as a
/// service by the agent module; edits apply from the next turn on.
#[derive(Clone)]
pub struct PersonaHandle {
    profile: Arc<RwLock<Profile>>,
}

impl PersonaHandle {
    pub fn new(profile: Profile) -> Self {
        Self {
            profile: Arc::new(RwLock::new(profile)),
        }
    }

    /// Runs `f` with the current profile.
    pub fn read<R>(&self, f: impl FnOnce(&Profile) -> R) -> R {
        f(&self.profile.read())
    }

    pub fn snapshot(&self) -> Profile {
        self.profile.read().clone()
    }

    pub fn sections(&self) -> Vec<PersonaSection> {
        self.profile.read().sections.clone()
    }

    pub fn set_section(&self, key: &str, body: impl Into<String>) {
        self.profile.write().set_section(key, body);
    }

    pub fn persona_prompt(&self) -> String {
        self.profile.read().persona_prompt()
    }

    pub fn display_name(&self) -> String {
        self.profile.read().display_name().to_owned()
    }

    /// Display name and nicknames, longest first.
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for name in self.profile.read().names() {
            let name = name.trim();
            if !name.is_empty() && !names.iter().any(|n| n == name) {
                names.push(name.to_owned());
            }
        }
        names.sort_by_key(|n| std::cmp::Reverse(n.chars().count()));
        names
    }
}
