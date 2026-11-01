//! Prompt contributor `memory`: the section 「你記得的事」.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use miyoria_store::MemoryKind;
use miyoria_types::{PromptContributor, PromptRequest, PromptSection};

use crate::engine::{MemoryEngine, Recalled};
use crate::scope::{present_people, request_scopes};
use crate::score::relative_date;

pub const CONTRIBUTOR_KEY: &str = "memory";
pub const SECTION_TITLE: &str = "你記得的事";
/// Kinds recalled into the prompt (followups go through initiative instead).
pub const PROMPT_KINDS: [MemoryKind; 3] =
    [MemoryKind::Episode, MemoryKind::Fact, MemoryKind::SelfNote];

pub struct MemoryContributor {
    engine: Arc<MemoryEngine>,
}

impl MemoryContributor {
    pub fn new(engine: Arc<MemoryEngine>) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl PromptContributor for MemoryContributor {
    fn key(&self) -> &str {
        CONTRIBUTOR_KEY
    }

    async fn contribute(&self, request: &PromptRequest) -> anyhow::Result<Vec<PromptSection>> {
        let scopes = request_scopes(request);
        let present = present_people(request);
        let mut query = request.query.clone();
        if let Some(last) = request.recent.last() {
            query.push('\n');
            query.push_str(last);
        }
        let recalled = self
            .engine
            .recall(
                &scopes,
                &present,
                &query,
                &PROMPT_KINDS,
                self.engine.config().recall_limit,
                request.now,
            )
            .await?;
        if recalled.is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![PromptSection {
            key: CONTRIBUTOR_KEY.to_owned(),
            title: SECTION_TITLE.to_owned(),
            body: format_lines(&recalled, request.now),
            order: 20,
        }])
    }
}

/// Bullet lines with relative dates, e.g. `- Owen 喜歡拉麵(三天前)`.
pub fn format_lines(recalled: &[Recalled], now: DateTime<Utc>) -> String {
    recalled
        .iter()
        .map(|r| {
            let content = r.record.content.replace('\n', " ");
            format!(
                "- {}({})",
                content.trim(),
                relative_date(r.record.created_at, now)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
