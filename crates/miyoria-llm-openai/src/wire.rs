//! Chat Completions wire format.

use miyoria_llm::{ChatMessage, ChatRequest, ChatRole, ToolSpec, Usage};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub(crate) struct RequestBody<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    stream: bool,
    stream_options: StreamOptions,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<Tool<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    stop: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

#[derive(Debug, Serialize)]
struct StreamOptions {
    include_usage: bool,
}

#[derive(Debug, Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: &'static str,
}

/// Only `content` / `tool_calls` are ever sent for assistant messages, so
/// reasoning output (e.g. DeepSeek `reasoning_content`) never goes back.
#[derive(Debug, Serialize)]
struct Message<'a> {
    role: &'static str,
    /// `null` for assistant messages that only carry tool calls.
    content: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<OutToolCall<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct OutToolCall<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    function: OutFunction<'a>,
}

#[derive(Debug, Serialize)]
struct OutFunction<'a> {
    name: &'a str,
    arguments: &'a str,
}

#[derive(Debug, Serialize)]
struct Tool<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    function: &'a ToolSpec,
}

impl<'a> RequestBody<'a> {
    pub(crate) fn new(req: &'a ChatRequest) -> Self {
        Self {
            model: &req.model,
            messages: req.messages.iter().map(Message::new).collect(),
            stream: true,
            stream_options: StreamOptions {
                include_usage: true,
            },
            tools: req
                .tools
                .iter()
                .map(|function| Tool {
                    kind: "function",
                    function,
                })
                .collect(),
            temperature: req.temperature,
            max_tokens: req.max_tokens,
            stop: &req.stop,
            response_format: req.json_mode.then_some(ResponseFormat {
                kind: "json_object",
            }),
        }
    }
}

impl<'a> Message<'a> {
    fn new(m: &'a ChatMessage) -> Self {
        let role = match m.role {
            ChatRole::System => "system",
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
            ChatRole::Tool => "tool",
        };
        let tool_calls = if m.role == ChatRole::Assistant {
            m.tool_calls
                .iter()
                .map(|c| OutToolCall {
                    id: &c.id,
                    kind: "function",
                    function: OutFunction {
                        name: &c.name,
                        arguments: &c.arguments,
                    },
                })
                .collect()
        } else {
            Vec::new()
        };
        let content = (!m.content.is_empty() || tool_calls.is_empty()).then_some(&*m.content);
        Self {
            role,
            content,
            name: m.name.as_deref(),
            tool_calls,
            tool_call_id: (m.role == ChatRole::Tool)
                .then_some(m.tool_call_id.as_deref())
                .flatten(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct Chunk {
    #[serde(default)]
    pub choices: Vec<Choice>,
    pub usage: Option<WireUsage>,
    pub error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Choice {
    pub delta: Option<Delta>,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Delta {
    pub content: Option<String>,
    /// DeepSeek.
    pub reasoning_content: Option<String>,
    /// OpenRouter and some local servers.
    pub reasoning: Option<String>,
    pub tool_calls: Option<Vec<ToolCallChunk>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ToolCallChunk {
    #[serde(default)]
    pub index: u32,
    pub id: Option<String>,
    pub function: Option<FunctionChunk>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FunctionChunk {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WireUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
    /// DeepSeek.
    prompt_cache_hit_tokens: Option<u32>,
    /// OpenAI.
    prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Deserialize)]
struct PromptTokensDetails {
    cached_tokens: Option<u32>,
}

impl From<WireUsage> for Usage {
    fn from(u: WireUsage) -> Self {
        Self {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            cached_prompt_tokens: u
                .prompt_cache_hit_tokens
                .or_else(|| u.prompt_tokens_details.and_then(|d| d.cached_tokens)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miyoria_llm::ToolCall;
    use serde_json::json;

    #[test]
    fn serializes_request() {
        let mut assistant = ChatMessage::assistant("");
        assistant.tool_calls.push(ToolCall {
            id: "call_1".into(),
            name: "roll".into(),
            arguments: "{\"sides\":6}".into(),
        });
        let req = ChatRequest {
            model: "deepseek-chat".into(),
            messages: vec![
                ChatMessage::system("sys"),
                ChatMessage::user("hi").with_name("owen"),
                assistant,
                ChatMessage::tool_result("call_1", "4"),
            ],
            tools: vec![ToolSpec {
                name: "roll".into(),
                description: "Roll a die".into(),
                parameters: json!({"type": "object"}),
            }],
            temperature: Some(0.5),
            json_mode: true,
            ..Default::default()
        };
        let body = serde_json::to_value(RequestBody::new(&req)).unwrap();
        assert_eq!(
            body,
            json!({
                "model": "deepseek-chat",
                "stream": true,
                "stream_options": {"include_usage": true},
                "messages": [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "hi", "name": "owen"},
                    {"role": "assistant", "content": null, "tool_calls": [
                        {"id": "call_1", "type": "function",
                         "function": {"name": "roll", "arguments": "{\"sides\":6}"}}
                    ]},
                    {"role": "tool", "content": "4", "tool_call_id": "call_1"},
                ],
                "tools": [{"type": "function", "function": {
                    "name": "roll", "description": "Roll a die", "parameters": {"type": "object"}
                }}],
                "temperature": 0.5,
                "response_format": {"type": "json_object"},
            })
        );
    }
}
