//! Per-turn context from other modules: every registered
//! [`PromptContributor`] is asked concurrently, each with a time limit, and
//! the sections of those that answered in time are added to the situation
//! message.

use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use miyoria_types::{PromptContributor, PromptContributors, PromptRequest, PromptSection};
use tracing::warn;

/// What the contributors returned.
#[derive(Debug, Default)]
pub(crate) struct Gathered {
    pub sections: Vec<PromptSection>,
    /// Keys of the contributors that answered in time.
    pub answered: Vec<String>,
    /// `"{key} (timed out)"` / `"{key} (failed)"`.
    pub skipped: Vec<String>,
}

impl Gathered {
    /// Lines for the decision trace.
    pub fn reasons(&self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.answered.is_empty() {
            out.push(format!("context from: {}", self.answered.join(", ")));
        }
        if !self.skipped.is_empty() {
            out.push(format!("context skipped: {}", self.skipped.join(", ")));
        }
        out
    }
}

/// Asks every contributor of `registry` at once; slow or failing ones are
/// skipped (with a warning).
pub(crate) async fn gather(
    registry: &PromptContributors,
    request: &PromptRequest,
    timeout: Duration,
) -> Gathered {
    let contributors = registry.all();
    if contributors.is_empty() {
        return Gathered::default();
    }
    let results = join_all(contributors.iter().map(|c| ask(c, request, timeout))).await;
    let mut out = Gathered::default();
    for (contributor, result) in contributors.iter().zip(results) {
        let key = contributor.key().to_owned();
        match result {
            Ok(sections) => {
                out.sections.extend(sections);
                out.answered.push(key);
            }
            Err(why) => out.skipped.push(format!("{key} ({why})")),
        }
    }
    out
}

async fn ask(
    contributor: &Arc<dyn PromptContributor>,
    request: &PromptRequest,
    timeout: Duration,
) -> Result<Vec<PromptSection>, &'static str> {
    let key = contributor.key();
    match tokio::time::timeout(timeout, contributor.contribute(request)).await {
        Ok(Ok(sections)) => Ok(sections),
        Ok(Err(e)) => {
            warn!(contributor = key, error = %format!("{e:#}"), "prompt contributor failed");
            Err("failed")
        }
        Err(_) => {
            warn!(
                contributor = key,
                timeout_ms = timeout.as_millis() as u64,
                "prompt contributor timed out"
            );
            Err("timed out")
        }
    }
}
