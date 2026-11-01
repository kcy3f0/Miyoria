//! Runtime control of the agent: per-context channel mode and activeness.

use std::collections::HashMap;
use std::sync::Arc;

use miyoria_store::SettingsStore;
use miyoria_types::{ContextKey, ProfileId};
use parking_lot::RwLock;
use tracing::warn;

use crate::config::{Activeness, AgentConfig, ChannelMode};
use crate::persona::PersonaHandle;

const MODE_PREFIX: &str = "channel_mode:";
const ACTIVENESS_PREFIX: &str = "activeness:";

/// Runtime overrides keyed by `ContextKey`'s display form
/// (`<platform>:<scope or dm>:<channel>`).
#[derive(Debug, Default)]
pub(crate) struct Overrides {
    modes: HashMap<String, ChannelMode>,
    activeness: HashMap<String, Activeness>,
}

/// Provided as the service `Arc<AgentHandle>` by the agent module.
///
/// Runtime overrides take precedence over `[modules.agent]` config, which
/// takes precedence over the profile. When a `dyn SettingsStore` service is
/// available at start, overrides are persisted per profile under
/// `channel_mode:<context>` / `activeness:<context>` and reloaded on start.
pub struct AgentHandle {
    config: AgentConfig,
    persona: PersonaHandle,
    overrides: Arc<RwLock<Overrides>>,
    store: Option<Arc<dyn SettingsStore>>,
}

impl AgentHandle {
    pub(crate) fn new(
        config: AgentConfig,
        persona: PersonaHandle,
        overrides: Arc<RwLock<Overrides>>,
        store: Option<Arc<dyn SettingsStore>>,
    ) -> Self {
        Self {
            config,
            persona,
            overrides,
            store,
        }
    }

    /// Settings key of the channel mode override for `context`.
    pub fn mode_key(context: &ContextKey) -> String {
        format!("{MODE_PREFIX}{context}")
    }

    /// Settings key of the activeness override for `context`.
    pub fn activeness_key(context: &ContextKey) -> String {
        format!("{ACTIVENESS_PREFIX}{context}")
    }

    /// Effective channel mode: runtime override, then config, then profile.
    pub fn channel_mode(&self, context: &ContextKey) -> ChannelMode {
        self.channel_mode_override(context)
            .unwrap_or_else(|| self.configured_channel_mode(context))
    }

    pub fn channel_mode_override(&self, context: &ContextKey) -> Option<ChannelMode> {
        self.overrides
            .read()
            .modes
            .get(&context.to_string())
            .copied()
    }

    /// Mode from config and profile only (what `reset` goes back to).
    pub fn configured_channel_mode(&self, context: &ContextKey) -> ChannelMode {
        let profile = self
            .persona
            .read(|p| p.manifest.behavior.default_channel_mode.clone());
        let profile = profile.parse().unwrap_or_else(|e| {
            warn!(error = %e, "invalid default_channel_mode in profile, using mention-only");
            ChannelMode::MentionOnly
        });
        self.config.mode_for(context, profile)
    }

    /// Sets (`Some`) or clears (`None`) the runtime override. It applies
    /// immediately; an error means it could not be persisted.
    pub async fn set_channel_mode(
        &self,
        context: &ContextKey,
        mode: Option<ChannelMode>,
    ) -> anyhow::Result<()> {
        {
            let mut o = self.overrides.write();
            match mode {
                Some(m) => o.modes.insert(context.to_string(), m),
                None => o.modes.remove(&context.to_string()),
            };
        }
        self.persist(&Self::mode_key(context), mode.map(|m| m.to_string()))
            .await
    }

    /// Effective activeness: runtime override, then config, then the
    /// profile's `behavior.initiative`.
    pub fn activeness(&self, context: &ContextKey) -> Activeness {
        self.activeness_override(context)
            .unwrap_or_else(|| self.configured_activeness(context))
    }

    pub fn activeness_override(&self, context: &ContextKey) -> Option<Activeness> {
        self.overrides
            .read()
            .activeness
            .get(&context.to_string())
            .copied()
    }

    pub fn configured_activeness(&self, context: &ContextKey) -> Activeness {
        let profile = self
            .persona
            .read(|p| p.manifest.behavior.initiative.clone());
        let profile = profile.parse().unwrap_or_else(|e| {
            warn!(error = %e, "invalid behavior.initiative in profile, using medium");
            Activeness::Medium
        });
        self.config.activeness_for(context, profile)
    }

    /// Like [`set_channel_mode`](Self::set_channel_mode), for activeness.
    pub async fn set_activeness(
        &self,
        context: &ContextKey,
        level: Option<Activeness>,
    ) -> anyhow::Result<()> {
        {
            let mut o = self.overrides.write();
            match level {
                Some(l) => o.activeness.insert(context.to_string(), l),
                None => o.activeness.remove(&context.to_string()),
            };
        }
        self.persist(&Self::activeness_key(context), level.map(|l| l.to_string()))
            .await
    }

    fn profile(&self) -> ProfileId {
        self.persona.read(|p| p.id.clone())
    }

    async fn persist(&self, key: &str, value: Option<String>) -> anyhow::Result<()> {
        let Some(store) = &self.store else {
            return Ok(());
        };
        store
            .set(&self.profile(), key, value.map(serde_json::Value::String))
            .await
    }

    /// Loads persisted overrides; returns how many were applied.
    pub(crate) async fn load(&self) -> anyhow::Result<usize> {
        let Some(store) = &self.store else {
            return Ok(0);
        };
        let profile = self.profile();
        let modes = store.list(&profile, MODE_PREFIX).await?;
        let levels = store.list(&profile, ACTIVENESS_PREFIX).await?;
        let mut o = self.overrides.write();
        let mut n = 0;
        for (key, value) in modes {
            match parse_entry::<ChannelMode>(&key, MODE_PREFIX, &value) {
                Some((ctx, mode)) => {
                    o.modes.insert(ctx, mode);
                    n += 1;
                }
                None => warn!(%key, %value, "ignoring invalid stored channel mode"),
            }
        }
        for (key, value) in levels {
            match parse_entry::<Activeness>(&key, ACTIVENESS_PREFIX, &value) {
                Some((ctx, level)) => {
                    o.activeness.insert(ctx, level);
                    n += 1;
                }
                None => warn!(%key, %value, "ignoring invalid stored activeness"),
            }
        }
        Ok(n)
    }
}

fn parse_entry<T: std::str::FromStr>(
    key: &str,
    prefix: &str,
    value: &serde_json::Value,
) -> Option<(String, T)> {
    let context = key.strip_prefix(prefix).filter(|c| !c.is_empty())?;
    let parsed = value.as_str()?.parse().ok()?;
    Some((context.to_owned(), parsed))
}
