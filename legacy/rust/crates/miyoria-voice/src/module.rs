use std::sync::Arc;

use async_trait::async_trait;
use miyoria_commands::CommandRegistry;
use miyoria_kernel::{Health, Module, ModuleContext, ModuleManifest};
use miyoria_speech::SpeechService;
use miyoria_store::SettingsStore;
use miyoria_types::{ProfileId, VoiceSink};
use parking_lot::Mutex;
use tokio::sync::Semaphore;
use tracing::{info, warn};

use crate::barge::BargeIn;
use crate::commands;
use crate::config::{VoiceConfig, VoiceProfile};
use crate::consent::Consent;
use crate::link::{VoiceLink, VoiceLinkModule};
use crate::listen::Listener;
use crate::sink::Speaker;

#[derive(Default)]
struct Running {
    link: Option<Arc<VoiceLink>>,
    registry: Option<Arc<CommandRegistry>>,
}

/// Module `voice`: listens in voice channels (VAD → ASR → `VoiceUtterance`)
/// and speaks (`dyn VoiceSink` → TTS → playback), with consent, barge-in and
/// the `join` / `leave` / `voice consent` commands.
///
/// Requires `voice.link` (`Arc<VoiceLink>`) and `speech`
/// (`Arc<SpeechService>`); uses `dyn SettingsStore` for consent flags and
/// `Arc<CommandRegistry>` for commands when available.
pub struct VoiceModule {
    manifest: ModuleManifest,
    profile_id: ProfileId,
    voice: Option<toml::Table>,
    running: Mutex<Running>,
}

impl VoiceModule {
    pub const ID: &'static str = "voice";

    /// `voice` is the profile's `voice.toml` (`Profile::voice`).
    pub fn new(profile_id: ProfileId, voice: Option<toml::Table>) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Voice")
                .description("Listens and speaks in voice channels")
                .requires(VoiceLinkModule::ID)
                .requires("speech")
                .optional("commands"),
            profile_id,
            voice,
            running: Mutex::new(Running::default()),
        }
    }
}

#[async_trait]
impl Module for VoiceModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: VoiceConfig = ctx.config()?;
        let config = Arc::new(config);
        let profile = Arc::new(VoiceProfile::parse(
            self.profile_id.as_str(),
            self.voice.as_ref(),
        )?);
        let link = ctx.services().require::<VoiceLink>()?;
        let speech = ctx.services().require::<SpeechService>()?;
        let store = ctx.services().get::<dyn SettingsStore>();
        if store.is_none() {
            warn!("no settings store: voice consent choices are kept in memory only");
        }
        let consent = Arc::new(Consent::new(config.consent, store));
        let barge = Arc::new(BargeIn::new(
            config.barge_in,
            config.barge_in_ms,
            config.barge_in_fade_ms,
        ));

        if !speech.has_tts() {
            warn!("no TTS provider configured: she cannot speak");
        }
        ctx.provide::<dyn VoiceSink>(Arc::new(Speaker {
            ctx: ctx.clone(),
            link: link.clone(),
            speech: speech.clone(),
            profile: profile.clone(),
            config: config.clone(),
            barge: barge.clone(),
        }));

        if speech.has_asr() {
            let listener = Listener {
                ctx: ctx.clone(),
                link: link.clone(),
                speech,
                consent: consent.clone(),
                config: config.clone(),
                barge,
                asr_slots: Arc::new(Semaphore::new(config.asr_concurrency.max(1))),
            };
            let audio = link.subscribe_audio();
            ctx.spawn("listen", listener.run(audio));
        } else {
            warn!("no ASR provider configured: she cannot listen");
        }

        let registry = ctx.services().get::<CommandRegistry>();
        *self.running.lock() = Running {
            link: Some(link.clone()),
            registry: registry.clone(),
        };
        if let Some(registry) = &registry {
            commands::register(registry, link, consent)?;
        }
        info!(voice = %profile.voice, consent = ?config.consent, "voice module running");
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        let running = std::mem::take(&mut *self.running.lock());
        if let Some(registry) = running.registry {
            commands::unregister(&registry);
        }
        Ok(())
    }

    async fn health(&self) -> Health {
        match &self.running.lock().link {
            Some(link) if !link.is_connected() => {
                Health::Degraded("voice node not connected".into())
            }
            _ => Health::Healthy,
        }
    }
}
