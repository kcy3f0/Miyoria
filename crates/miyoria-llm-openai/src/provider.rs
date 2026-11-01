use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use futures::stream::BoxStream;
use miyoria_llm::{ChatProvider, ChatRequest, ChatStream, ProviderConfig, StreamEvent, Usage};
use reqwest::header::{self, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Response, StatusCode};
use serde::Deserialize;
use tracing::{debug, warn};

use crate::sse::SseParser;
use crate::wire::{Chunk, RequestBody};

const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
const OPENCODE_BASE_URL: &str = "https://opencode.ai/inference/go/v1";
/// Header OpenCode reads the conversation id from.
pub const OPENCODE_SESSION_HEADER: &str = "x-opencode-session";
/// Identifies Miyoria (not the HTTP library) to every provider.
pub const DEFAULT_USER_AGENT: &str = concat!("miyoria/", env!("CARGO_PKG_VERSION"));
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// Settings for [`OpenAiProvider`]. `Debug` redacts the API key and header
/// values.
#[derive(Clone)]
pub struct OpenAiConfig {
    /// API root; `/chat/completions` is appended as-is (no `/v1` is added).
    pub base_url: String,
    /// Sent as `Authorization: Bearer ...` when set.
    pub api_key: Option<String>,
    /// Extra request headers.
    pub headers: BTreeMap<String, String>,
    /// `User-Agent` of every request. A `User-Agent` entry in `headers`
    /// takes precedence.
    pub user_agent: String,
    /// Name of the header that carries [`ChatRequest::session`] (e.g.
    /// `x-opencode-session`). Nothing is sent when `None` or when the
    /// request has no session.
    pub session_header: Option<String>,
    /// Max idle time while waiting for response bytes (headers or stream).
    pub timeout: Duration,
    /// Retries for 429 / 5xx / connect errors before the stream starts.
    pub max_retries: u32,
    /// First retry delay; doubles on every attempt unless `Retry-After` is sent.
    pub retry_backoff: Duration,
}

impl OpenAiConfig {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: None,
            headers: BTreeMap::new(),
            user_agent: DEFAULT_USER_AGENT.to_owned(),
            session_header: None,
            timeout: Duration::from_secs(120),
            max_retries: 2,
            retry_backoff: Duration::from_millis(500),
        }
    }

    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    /// Reads `base_url`, `api_key` and the extras `timeout_secs`,
    /// `max_retries`, `headers`, `user_agent` and `session_header`.
    ///
    /// `openai`, `deepseek` and `opencode` default `base_url` to the official
    /// endpoints. `opencode` also requires an API key and defaults
    /// `session_header` to `x-opencode-session` (set it to `""` to turn the
    /// header off).
    pub fn from_provider_config(config: &ProviderConfig) -> anyhow::Result<Self> {
        #[derive(Default, Deserialize)]
        #[serde(default)]
        struct Extra {
            timeout_secs: Option<u64>,
            max_retries: Option<u32>,
            headers: BTreeMap<String, String>,
            user_agent: Option<String>,
            session_header: Option<String>,
        }

        let extra: Extra = serde_json::from_value(serde_json::Value::Object(config.extra.clone()))
            .map_err(|e| anyhow::anyhow!("invalid provider settings: {e}"))?;
        let base_url = match (config.base_url.as_deref(), config.kind.as_str()) {
            (Some(url), _) if !url.trim().is_empty() => url.trim().to_owned(),
            (_, "openai") => OPENAI_BASE_URL.to_owned(),
            (_, "deepseek") => DEEPSEEK_BASE_URL.to_owned(),
            (_, "opencode") => OPENCODE_BASE_URL.to_owned(),
            _ => anyhow::bail!("`base_url` is required for kind `{}`", config.kind),
        };
        let mut out = Self::new(base_url);
        out.api_key = config.api_key.clone().filter(|k| !k.trim().is_empty());
        out.headers = extra.headers;
        if config.kind == "opencode" && out.api_key.is_none() {
            anyhow::bail!("`api_key` is required for kind `opencode`");
        }
        if let Some(ua) = extra.user_agent.filter(|u| !u.trim().is_empty()) {
            out.user_agent = ua.trim().to_owned();
        }
        out.session_header = match extra.session_header {
            Some(h) => Some(h.trim().to_owned()).filter(|h| !h.is_empty()),
            None if config.kind == "opencode" => Some(OPENCODE_SESSION_HEADER.to_owned()),
            None => None,
        };
        if let Some(secs) = extra.timeout_secs {
            out.timeout = Duration::from_secs(secs);
        }
        if let Some(n) = extra.max_retries {
            out.max_retries = n;
        }
        Ok(out)
    }
}

impl fmt::Debug for OpenAiConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiConfig")
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("headers", &self.headers.keys().collect::<Vec<_>>())
            .field("user_agent", &self.user_agent)
            .field("session_header", &self.session_header)
            .field("timeout", &self.timeout)
            .field("max_retries", &self.max_retries)
            .field("retry_backoff", &self.retry_backoff)
            .finish()
    }
}

/// Streaming Chat Completions client for OpenAI-compatible APIs
/// (OpenAI, DeepSeek, OpenRouter, Ollama, vLLM, llama.cpp, LM Studio, ...).
pub struct OpenAiProvider {
    name: String,
    url: String,
    client: reqwest::Client,
    session_header: Option<HeaderName>,
    max_retries: u32,
    retry_backoff: Duration,
}

impl OpenAiProvider {
    pub fn new(name: impl Into<String>, config: OpenAiConfig) -> anyhow::Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_str(&config.user_agent)
                .map_err(|_| anyhow::anyhow!("invalid `user_agent`"))?,
        );
        let session_header = config
            .session_header
            .as_deref()
            .map(|h| {
                HeaderName::from_bytes(h.as_bytes())
                    .map_err(|_| anyhow::anyhow!("invalid `session_header` name `{h}`"))
            })
            .transpose()?;
        if let Some(key) = &config.api_key {
            let mut value = HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|_| anyhow::anyhow!("API key contains invalid characters"))?;
            value.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, value);
        }
        for (k, v) in &config.headers {
            let name = HeaderName::from_bytes(k.as_bytes())
                .map_err(|_| anyhow::anyhow!("invalid header name `{k}`"))?;
            let value = HeaderValue::from_str(v)
                .map_err(|_| anyhow::anyhow!("invalid value for header `{k}`"))?;
            headers.insert(name, value);
        }
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(10).min(config.timeout))
            .read_timeout(config.timeout)
            .build()?;
        Ok(Self {
            name: name.into(),
            url: format!("{}/chat/completions", config.base_url.trim_end_matches('/')),
            client,
            session_header,
            max_retries: config.max_retries,
            retry_backoff: config.retry_backoff,
        })
    }

    /// The session header value for `request`, if one is configured and the
    /// request has a (header-safe) session id.
    fn session_value(&self, request: &ChatRequest) -> Option<HeaderValue> {
        self.session_header.as_ref()?;
        let session = request.session.as_deref()?;
        match HeaderValue::from_str(session) {
            Ok(v) => Some(v),
            Err(_) => {
                warn!(provider = %self.name, "session id is not a valid header value, not sent");
                None
            }
        }
    }

    /// Full request URL (`{base_url}/chat/completions`).
    pub fn url(&self) -> &str {
        &self.url
    }

    fn backoff(&self, attempt: u32) -> Duration {
        self.retry_backoff
            .saturating_mul(2u32.saturating_pow(attempt))
            .min(MAX_BACKOFF)
    }

    /// Sends the request, retrying transient failures. Returns once a 2xx
    /// response arrives, i.e. before any of the stream is consumed.
    async fn send(&self, body: Bytes, session: Option<&HeaderValue>) -> anyhow::Result<Response> {
        let mut attempt = 0;
        loop {
            let mut builder = self
                .client
                .post(&self.url)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "text/event-stream");
            if let (Some(name), Some(value)) = (&self.session_header, session) {
                builder = builder.header(name.clone(), value.clone());
            }
            let result = builder.body(body.clone()).send().await;
            let delay = match result {
                Ok(resp) if resp.status().is_success() => return Ok(resp),
                Ok(resp) if attempt < self.max_retries && is_retryable(resp.status()) => {
                    let delay = retry_after(&resp).unwrap_or_else(|| self.backoff(attempt));
                    warn!(provider = %self.name, status = %resp.status(), ?delay, "LLM request failed, retrying");
                    delay
                }
                Ok(resp) => return Err(http_error(&self.name, resp).await),
                Err(e) if attempt < self.max_retries && (e.is_connect() || e.is_timeout()) => {
                    let delay = self.backoff(attempt);
                    warn!(provider = %self.name, error = %e, ?delay, "LLM request failed, retrying");
                    delay
                }
                Err(e) => {
                    return Err(
                        anyhow::Error::new(e).context(format!("{}: request failed", self.name))
                    );
                }
            };
            tokio::time::sleep(delay).await;
            attempt += 1;
        }
    }
}

impl fmt::Debug for OpenAiProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiProvider")
            .field("name", &self.name)
            .field("url", &self.url)
            .field("session_header", &self.session_header)
            .field("max_retries", &self.max_retries)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl ChatProvider for OpenAiProvider {
    fn name(&self) -> &str {
        &self.name
    }

    async fn stream(&self, request: ChatRequest) -> anyhow::Result<ChatStream> {
        let body = serde_json::to_vec(&RequestBody::new(&request))?;
        debug!(provider = %self.name, model = %request.model, url = %self.url, "chat completion request");
        let session = self.session_value(&request);
        let response = self.send(body.into(), session.as_ref()).await?;
        Ok(EventStream::new(self.name.clone(), response).into_stream())
    }
}

fn is_retryable(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn retry_after(resp: &Response) -> Option<Duration> {
    let secs: u64 = resp
        .headers()
        .get(header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(secs).min(MAX_RETRY_AFTER))
}

async fn http_error(provider: &str, resp: Response) -> anyhow::Error {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    anyhow::anyhow!("{provider}: HTTP {status}: {}", snippet(&body))
}

fn snippet(s: &str) -> String {
    const MAX: usize = 500;
    let s = s.trim();
    match s.char_indices().nth(MAX) {
        Some((i, _)) => format!("{}...", &s[..i]),
        None => s.to_owned(),
    }
}

/// Turns the SSE byte stream into [`StreamEvent`]s, ending with exactly one
/// `Done` (or an error).
struct EventStream {
    provider: String,
    bytes: BoxStream<'static, reqwest::Result<Bytes>>,
    parser: SseParser,
    pending: VecDeque<anyhow::Result<StreamEvent>>,
    finish_reason: Option<String>,
    usage: Option<Usage>,
    finished: bool,
}

impl EventStream {
    fn new(provider: String, response: Response) -> Self {
        Self {
            provider,
            bytes: response.bytes_stream().boxed(),
            parser: SseParser::default(),
            pending: VecDeque::new(),
            finish_reason: None,
            usage: None,
            finished: false,
        }
    }

    fn into_stream(self) -> ChatStream {
        futures::stream::unfold(self, |mut st| async move {
            loop {
                if let Some(ev) = st.pending.pop_front() {
                    return Some((ev, st));
                }
                if st.finished {
                    return None;
                }
                match st.bytes.next().await {
                    Some(Ok(bytes)) => {
                        for payload in st.parser.push(&bytes) {
                            st.handle(&payload);
                        }
                    }
                    Some(Err(e)) => st.fail(
                        anyhow::Error::new(e)
                            .context(format!("{}: stream interrupted", st.provider)),
                    ),
                    None => {
                        for payload in st.parser.finish() {
                            st.handle(&payload);
                        }
                        if !st.finished {
                            // Some servers omit `[DONE]`; accept a stream that
                            // reported how it finished.
                            if st.finish_reason.is_some() || st.usage.is_some() {
                                st.done();
                            } else {
                                let msg = format!("{}: stream ended unexpectedly", st.provider);
                                st.fail(anyhow::anyhow!(msg));
                            }
                        }
                    }
                }
            }
        })
        .boxed()
    }

    fn handle(&mut self, payload: &str) {
        let payload = payload.trim();
        if self.finished || payload.is_empty() {
            return;
        }
        if payload == "[DONE]" {
            self.done();
            return;
        }
        let chunk: Chunk = match serde_json::from_str(payload) {
            Ok(c) => c,
            Err(e) => {
                let msg = format!(
                    "{}: invalid stream chunk ({e}): {}",
                    self.provider,
                    snippet(payload)
                );
                return self.fail(anyhow::anyhow!(msg));
            }
        };
        if let Some(err) = chunk.error {
            let msg = format!("{}: error in stream: {err}", self.provider);
            return self.fail(anyhow::anyhow!(msg));
        }
        if let Some(usage) = chunk.usage {
            self.usage = Some(usage.into());
        }
        for choice in chunk.choices {
            if let Some(delta) = choice.delta {
                let reasoning = delta.reasoning_content.or(delta.reasoning);
                if let Some(r) = reasoning.filter(|r| !r.is_empty()) {
                    self.pending.push_back(Ok(StreamEvent::ReasoningDelta(r)));
                }
                if let Some(t) = delta.content.filter(|t| !t.is_empty()) {
                    self.pending.push_back(Ok(StreamEvent::TextDelta(t)));
                }
                for call in delta.tool_calls.into_iter().flatten() {
                    let (name, arguments) = call
                        .function
                        .map(|f| (f.name, f.arguments.unwrap_or_default()))
                        .unwrap_or_default();
                    self.pending.push_back(Ok(StreamEvent::ToolCallDelta {
                        index: call.index,
                        id: call.id,
                        name,
                        arguments,
                    }));
                }
            }
            if choice.finish_reason.is_some() {
                self.finish_reason = choice.finish_reason;
            }
        }
    }

    fn done(&mut self) {
        self.pending.push_back(Ok(StreamEvent::Done {
            finish_reason: self.finish_reason.take(),
            usage: self.usage.take(),
        }));
        self.finished = true;
    }

    fn fail(&mut self, err: anyhow::Error) {
        self.pending.push_back(Err(err));
        self.finished = true;
    }
}
