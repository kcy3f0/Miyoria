use std::fmt;
use std::str::FromStr;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    /// Optional speaker name (OpenAI `name` field).
    pub name: Option<String>,
    /// Tool calls made by the assistant in this message.
    pub tool_calls: Vec<ToolCall>,
    /// For `Tool` messages: which call this answers.
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    fn plain(role: ChatRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            name: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self::plain(ChatRole::System, content)
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::plain(ChatRole::User, content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::plain(ChatRole::Assistant, content)
    }

    pub fn tool_result(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            tool_call_id: Some(call_id.into()),
            ..Self::plain(ChatRole::Tool, content)
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments object.
    pub parameters: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments as produced by the model.
    pub arguments: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ChatRequest {
    /// Filled in by the router from the purpose's model chain; providers use
    /// it as the model id sent to the API.
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub stop: Vec<String>,
    /// Ask for a JSON object response when the provider supports it.
    pub json_mode: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// Prompt tokens served from the provider's prefix cache, if reported.
    pub cached_prompt_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum StreamEvent {
    /// Visible answer text.
    TextDelta(String),
    /// Model "thinking" (e.g. DeepSeek `reasoning_content`). Must never be
    /// spoken, sent to chat, or put back into the conversation history.
    ReasoningDelta(String),
    /// Incremental tool call; fragments with the same `index` belong together.
    ToolCallDelta {
        index: u32,
        id: Option<String>,
        name: Option<String>,
        arguments: String,
    },
    Done {
        finish_reason: Option<String>,
        usage: Option<Usage>,
    },
}

pub type ChatStream = BoxStream<'static, anyhow::Result<StreamEvent>>;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ChatResponse {
    pub text: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub usage: Option<Usage>,
}

impl ChatResponse {
    /// Folds a stream into a full response.
    pub async fn collect(mut stream: ChatStream) -> anyhow::Result<Self> {
        let mut out = Self::default();
        let mut calls: Vec<ToolCall> = Vec::new();
        while let Some(ev) = stream.next().await {
            match ev? {
                StreamEvent::TextDelta(t) => out.text.push_str(&t),
                StreamEvent::ReasoningDelta(t) => out.reasoning.push_str(&t),
                StreamEvent::ToolCallDelta {
                    index,
                    id,
                    name,
                    arguments,
                } => {
                    let index = index as usize;
                    while calls.len() <= index {
                        calls.push(ToolCall {
                            id: String::new(),
                            name: String::new(),
                            arguments: String::new(),
                        });
                    }
                    let call = &mut calls[index];
                    if let Some(id) = id {
                        call.id = id;
                    }
                    if let Some(name) = name {
                        call.name.push_str(&name);
                    }
                    call.arguments.push_str(&arguments);
                }
                StreamEvent::Done {
                    finish_reason,
                    usage,
                } => {
                    out.finish_reason = finish_reason;
                    out.usage = usage;
                }
            }
        }
        out.tool_calls = calls;
        Ok(out)
    }
}

#[async_trait]
pub trait ChatProvider: Send + Sync {
    /// Provider instance name from config, e.g. `"deepseek"`.
    fn name(&self) -> &str;

    async fn stream(&self, request: ChatRequest) -> anyhow::Result<ChatStream>;

    async fn complete(&self, request: ChatRequest) -> anyhow::Result<ChatResponse> {
        ChatResponse::collect(self.stream(request).await?).await
    }
}

/// `provider:model`, e.g. `deepseek:deepseek-chat`. The model part may itself
/// contain `:` (split happens at the first one).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
}

impl FromStr for ModelRef {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.split_once(':') {
            Some((p, m)) if !p.is_empty() && !m.is_empty() => Ok(Self {
                provider: p.to_owned(),
                model: m.to_owned(),
            }),
            _ => anyhow::bail!("model reference `{s}` must look like `provider:model`"),
        }
    }
}

impl TryFrom<String> for ModelRef {
    type Error = anyhow::Error;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        s.parse()
    }
}

impl From<ModelRef> for String {
    fn from(m: ModelRef) -> Self {
        m.to_string()
    }
}

impl fmt::Display for ModelRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.provider, self.model)
    }
}
