//! Time source, replaceable so tests can run on paused tokio time.

use chrono::{DateTime, Utc};
use tokio::time::Instant;

/// Source of "now".
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

/// The wall clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// A clock that starts at a fixed instant and follows tokio's (possibly
/// paused) time, so `tokio::time::advance` moves it too.
#[derive(Clone, Copy, Debug)]
pub struct TokioClock {
    start: DateTime<Utc>,
    base: Instant,
}

impl TokioClock {
    /// Reads `start` as "now" at the moment of creation.
    pub fn new(start: DateTime<Utc>) -> Self {
        Self {
            start,
            base: Instant::now(),
        }
    }
}

impl Clock for TokioClock {
    fn now(&self) -> DateTime<Utc> {
        let elapsed = Instant::now().saturating_duration_since(self.base);
        self.start + chrono::Duration::from_std(elapsed).unwrap_or_default()
    }
}
