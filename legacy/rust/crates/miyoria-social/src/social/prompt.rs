use std::sync::Arc;

use async_trait::async_trait;
use miyoria_types::{PromptContributor, PromptRequest, PromptSection};

use super::engine::Social;

/// Prompt contributor `social`: the `在場的人` section (name, label, call
/// name, tags, short notes). Answers from memory.
pub struct SocialPrompt {
    social: Arc<Social>,
}

impl SocialPrompt {
    pub const KEY: &'static str = "social";

    pub fn new(social: Arc<Social>) -> Self {
        Self { social }
    }
}

#[async_trait]
impl PromptContributor for SocialPrompt {
    fn key(&self) -> &str {
        Self::KEY
    }

    async fn contribute(&self, request: &PromptRequest) -> anyhow::Result<Vec<PromptSection>> {
        let lines = self
            .social
            .describe_people(&request.participants, &request.speakers);
        if lines.is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![PromptSection {
            key: Self::KEY.to_owned(),
            title: "在場的人".to_owned(),
            body: format!(
                "{}\n(標籤與印象只是參考,不要把這些資訊直接念出來。)",
                lines.join("\n")
            ),
            order: 20,
        }])
    }
}
