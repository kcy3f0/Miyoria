//! Per-user consent to being listened to.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use miyoria_store::SettingsStore;
use miyoria_types::{AccountRef, ProfileId};
use parking_lot::Mutex;
use serde::Deserialize;
use tracing::warn;

/// Settings profile consent flags are stored under (they are not tied to a
/// character).
pub const CONSENT_PROFILE: &str = "_global";

/// Whether users are listened to unless they opt out, or only after opting in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConsentPolicy {
    #[default]
    OptOut,
    OptIn,
}

impl ConsentPolicy {
    pub fn default_allowed(self) -> bool {
        matches!(self, Self::OptOut)
    }
}

/// Settings key of one user's flag: `voice_consent:<platform>:<user_id>`.
pub fn consent_key(account: &AccountRef) -> String {
    format!("voice_consent:{}:{}", account.platform, account.id)
}

const CACHE_TTL: Duration = Duration::from_secs(60);

/// Consent lookups, backed by `dyn SettingsStore` (or memory only when no
/// store is available) with a short cache.
pub struct Consent {
    policy: ConsentPolicy,
    store: Option<Arc<dyn SettingsStore>>,
    profile: ProfileId,
    cache: Mutex<HashMap<AccountRef, (bool, Instant)>>,
    /// Flags set while no store is available.
    local: Mutex<HashMap<AccountRef, bool>>,
}

impl Consent {
    pub fn new(policy: ConsentPolicy, store: Option<Arc<dyn SettingsStore>>) -> Self {
        Self {
            policy,
            store,
            profile: ProfileId::from(CONSENT_PROFILE),
            cache: Mutex::new(HashMap::new()),
            local: Mutex::new(HashMap::new()),
        }
    }

    pub fn policy(&self) -> ConsentPolicy {
        self.policy
    }

    /// Whether `account` may be listened to. Store errors count as "no"
    /// (fail closed).
    pub async fn allowed(&self, account: &AccountRef) -> bool {
        let cached = self
            .cache
            .lock()
            .get(account)
            .filter(|(_, at)| at.elapsed() < CACHE_TTL)
            .map(|(value, _)| *value);
        if let Some(value) = cached {
            return value;
        }
        let value = match &self.store {
            Some(store) => match store.get(&self.profile, &consent_key(account)).await {
                Ok(Some(v)) => v.as_bool().unwrap_or(self.policy.default_allowed()),
                Ok(None) => self.policy.default_allowed(),
                Err(e) => {
                    warn!(error = %e, "cannot read voice consent; not listening");
                    return false;
                }
            },
            None => self
                .local
                .lock()
                .get(account)
                .copied()
                .unwrap_or(self.policy.default_allowed()),
        };
        self.cache
            .lock()
            .insert(account.clone(), (value, Instant::now()));
        value
    }

    /// Records `account`'s choice.
    pub async fn set(&self, account: &AccountRef, allowed: bool) -> anyhow::Result<()> {
        match &self.store {
            Some(store) => {
                store
                    .set(
                        &self.profile,
                        &consent_key(account),
                        Some(serde_json::Value::Bool(allowed)),
                    )
                    .await?;
            }
            None => {
                self.local.lock().insert(account.clone(), allowed);
            }
        }
        self.cache
            .lock()
            .insert(account.clone(), (allowed, Instant::now()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use miyoria_store::Store;
    use miyoria_types::PlatformId;

    use super::*;

    fn acc(id: &str) -> AccountRef {
        AccountRef {
            platform: PlatformId::new("discord"),
            id: id.to_owned(),
        }
    }

    #[tokio::test]
    async fn opt_out_by_default() {
        let store = Store::memory().settings;
        let c = Consent::new(ConsentPolicy::OptOut, Some(store.clone()));
        assert!(c.allowed(&acc("1")).await);
        c.set(&acc("1"), false).await.unwrap();
        assert!(!c.allowed(&acc("1")).await);
        assert!(c.allowed(&acc("2")).await);
        let stored = store
            .get(&ProfileId::from("_global"), "voice_consent:discord:1")
            .await
            .unwrap();
        assert_eq!(stored, Some(serde_json::Value::Bool(false)));
        // A fresh instance reads the stored flag.
        let again = Consent::new(ConsentPolicy::OptOut, Some(store));
        assert!(!again.allowed(&acc("1")).await);
    }

    #[tokio::test]
    async fn opt_in_and_memory_only() {
        let c = Consent::new(ConsentPolicy::OptIn, None);
        assert!(!c.allowed(&acc("1")).await);
        c.set(&acc("1"), true).await.unwrap();
        assert!(c.allowed(&acc("1")).await);
        assert!(!c.allowed(&acc("2")).await);
    }
}
