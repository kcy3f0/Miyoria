//! Barge-in: stop her playback when someone talks over her.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use tracing::info;

use crate::config::BargeInMode;
use crate::link::Stoppable;

struct Active {
    token: u64,
    handle: Arc<dyn Stoppable>,
    stopped: bool,
}

/// Tracks her current playback per guild and stops it once a listener has
/// been talking for `threshold_ms`.
pub struct BargeIn {
    mode: BargeInMode,
    threshold_ms: u32,
    fade_ms: u32,
    active: Mutex<HashMap<String, Active>>,
    next: AtomicU64,
}

impl BargeIn {
    pub fn new(mode: BargeInMode, threshold_ms: u32, fade_ms: u32) -> Self {
        Self {
            mode,
            threshold_ms,
            fade_ms,
            active: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        }
    }

    /// Registers the playback now running in `guild`. Returns a token for
    /// [`unregister`](Self::unregister).
    pub fn register(&self, guild: &str, handle: Arc<dyn Stoppable>) -> u64 {
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        self.active.lock().insert(
            guild.to_owned(),
            Active {
                token,
                handle,
                stopped: false,
            },
        );
        token
    }

    pub fn unregister(&self, guild: &str, token: u64) {
        let mut active = self.active.lock();
        if active.get(guild).is_some_and(|a| a.token == token) {
            active.remove(guild);
        }
    }

    /// Reports that a consented, non-self participant in `guild` has been
    /// speaking for `speech_run_ms`. Returns whether this stopped a playback.
    pub fn observe(&self, guild: &str, speech_run_ms: u32) -> bool {
        if self.mode == BargeInMode::Ignore || speech_run_ms < self.threshold_ms {
            return false;
        }
        let mut active = self.active.lock();
        let Some(a) = active.get_mut(guild) else {
            return false;
        };
        if a.stopped {
            return false;
        }
        a.stopped = true;
        info!(%guild, speech_run_ms, "barge-in: stopping playback");
        a.handle.stop(self.fade_ms);
        true
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU32;

    use super::*;

    #[derive(Default)]
    struct FakePlayback {
        stops: AtomicU32,
        fade: AtomicU32,
    }

    impl Stoppable for FakePlayback {
        fn stop(&self, fade_ms: u32) {
            self.stops.fetch_add(1, Ordering::SeqCst);
            self.fade.store(fade_ms, Ordering::SeqCst);
        }
    }

    #[test]
    fn stops_after_threshold_once() {
        let b = BargeIn::new(BargeInMode::Stop, 600, 120);
        let p = Arc::new(FakePlayback::default());
        assert!(!b.observe("g", 1000), "nothing playing");
        let token = b.register("g", p.clone());
        assert!(!b.observe("g", 400));
        assert!(!b.observe("other", 900));
        assert!(b.observe("g", 620));
        assert!(!b.observe("g", 900), "only once");
        assert_eq!(p.stops.load(Ordering::SeqCst), 1);
        assert_eq!(p.fade.load(Ordering::SeqCst), 120);
        b.unregister("g", token);
        assert!(!b.observe("g", 900));
    }

    #[test]
    fn ignore_mode_never_stops() {
        let b = BargeIn::new(BargeInMode::Ignore, 600, 120);
        let p = Arc::new(FakePlayback::default());
        b.register("g", p.clone());
        assert!(!b.observe("g", 5000));
        assert_eq!(p.stops.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stale_unregister_keeps_newer_playback() {
        let b = BargeIn::new(BargeInMode::Stop, 600, 0);
        let old = b.register("g", Arc::new(FakePlayback::default()));
        let p = Arc::new(FakePlayback::default());
        b.register("g", p.clone());
        b.unregister("g", old);
        assert!(b.observe("g", 700));
        assert_eq!(p.stops.load(Ordering::SeqCst), 1);
    }
}
