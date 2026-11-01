//! Typed client for the admin API, used by the CLI.

use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use futures::StreamExt;
use futures::stream::BoxStream;
use miyoria_store::{DecisionRecord, PersonaOverride};
use miyoria_types::{ContextKey, Envelope};
use reqwest::{Method, RequestBuilder, Response, StatusCode, Url};
use serde::de::DeserializeOwned;

use crate::types::{
    ErrorBody, HealthInfo, ModuleInfo, PersonaSectionInfo, SetPersonaRequest, SetPersonaResponse,
    UsageInfo,
};

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("invalid API base URL `{0}`")]
    InvalidUrl(String),
    #[error("cannot reach the admin API: {0}")]
    Transport(#[from] reqwest::Error),
    /// The server answered with a non-success status.
    #[error("admin API returned {status}: {message}")]
    Api { status: StatusCode, message: String },
    #[error("invalid event from the admin API: {0}")]
    Decode(String),
}

impl ClientError {
    /// HTTP status of an [`Api`](Self::Api) error.
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Self::Api { status, .. } => Some(*status),
            _ => None,
        }
    }
}

pub type Result<T, E = ClientError> = std::result::Result<T, E>;

/// Stream of bus envelopes from `GET /api/events`.
pub type EventStream = BoxStream<'static, Result<Envelope>>;

/// Admin API client. Cheap to clone.
#[derive(Clone, Debug)]
pub struct ApiClient {
    http: reqwest::Client,
    base: Url,
    token: String,
}

impl ApiClient {
    /// `base_url` is e.g. `http://127.0.0.1:7878`.
    pub fn new(base_url: &str, token: impl Into<String>) -> Result<Self> {
        let base =
            Url::parse(base_url).map_err(|_| ClientError::InvalidUrl(base_url.to_owned()))?;
        if base.cannot_be_a_base() || !matches!(base.scheme(), "http" | "https") {
            return Err(ClientError::InvalidUrl(base_url.to_owned()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self {
            http,
            base,
            token: token.into(),
        })
    }

    pub async fn health(&self) -> Result<HealthInfo> {
        self.json(self.request(Method::GET, &["health"])).await
    }

    pub async fn modules(&self) -> Result<Vec<ModuleInfo>> {
        self.json(self.request(Method::GET, &["modules"])).await
    }

    /// `action` is `"enable"`, `"disable"` or `"restart"`. Returns the
    /// module's status afterwards.
    pub async fn module_action(&self, id: &str, action: &str) -> Result<ModuleInfo> {
        self.json(self.request(Method::POST, &["modules", id, action]))
            .await
    }

    /// The newest `limit` attention decisions, newest first.
    pub async fn decisions(&self, limit: usize) -> Result<Vec<DecisionRecord>> {
        self.decisions_in(None, limit).await
    }

    /// Like [`decisions`](Self::decisions), optionally for one context only.
    pub async fn decisions_in(
        &self,
        context: Option<&ContextKey>,
        limit: usize,
    ) -> Result<Vec<DecisionRecord>> {
        let mut url = self.url(&["decisions"]);
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("limit", &limit.to_string());
            if let Some(context) = context {
                let json = serde_json::to_string(context).expect("ContextKey serializes");
                q.append_pair("context", &json);
            }
        }
        self.json(self.http.get(url)).await
    }

    /// Token usage per `provider:model` since the core started.
    pub async fn usage(&self) -> Result<BTreeMap<String, UsageInfo>> {
        self.json(self.request(Method::GET, &["llm", "usage"]))
            .await
    }

    pub async fn persona(&self) -> Result<Vec<PersonaSectionInfo>> {
        self.json(self.request(Method::GET, &["persona"])).await
    }

    /// Replaces a persona section (recorded as edited by `"api"`). Returns the
    /// new version number.
    pub async fn set_persona(&self, key: &str, body: &str) -> Result<u32> {
        self.set_persona_as(key, body, None).await
    }

    /// Like [`set_persona`](Self::set_persona) with an explicit editor name.
    pub async fn set_persona_as(
        &self,
        key: &str,
        body: &str,
        edited_by: Option<&str>,
    ) -> Result<u32> {
        let request = SetPersonaRequest {
            body: body.to_owned(),
            edited_by: edited_by.map(str::to_owned),
        };
        let response: SetPersonaResponse = self
            .json(self.request(Method::PUT, &["persona", key]).json(&request))
            .await?;
        Ok(response.version)
    }

    /// Every stored version of a persona section, oldest first.
    pub async fn persona_history(&self, key: &str) -> Result<Vec<PersonaOverride>> {
        self.json(self.request(Method::GET, &["persona", key, "history"]))
            .await
    }

    /// Streams bus envelopes matching `topics` (e.g. `["platform.*",
    /// "agent.*"]`; empty means everything). The subscription is active once
    /// this returns; the stream ends when the server stops.
    pub async fn events<I, S>(&self, topics: I) -> Result<EventStream>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let topics: Vec<String> = topics.into_iter().map(|t| t.as_ref().to_owned()).collect();
        let mut url = self.url(&["events"]);
        if !topics.is_empty() {
            url.query_pairs_mut()
                .append_pair("topics", &topics.join(","));
        }
        let response = self.send(self.http.get(url)).await?;
        let state = (
            response.bytes_stream(),
            SseParser::default(),
            VecDeque::<String>::new(),
        );
        let stream =
            futures::stream::unfold(state, |(mut bytes, mut parser, mut pending)| async move {
                loop {
                    if let Some(data) = pending.pop_front() {
                        let item = serde_json::from_str::<Envelope>(&data)
                            .map_err(|e| ClientError::Decode(e.to_string()));
                        return Some((item, (bytes, parser, pending)));
                    }
                    match bytes.next().await? {
                        Ok(chunk) => pending.extend(parser.feed(&chunk)),
                        Err(e) => return Some((Err(e.into()), (bytes, parser, pending))),
                    }
                }
            });
        Ok(stream.boxed())
    }

    fn url(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .expect("checked in new")
            .pop_if_empty()
            .push("api")
            .extend(segments);
        url
    }

    fn request(&self, method: Method, segments: &[&str]) -> RequestBuilder {
        self.http.request(method, self.url(segments))
    }

    async fn send(&self, request: RequestBuilder) -> Result<Response> {
        let response = request.bearer_auth(&self.token).send().await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let text = response.text().await.unwrap_or_default();
        let message = match serde_json::from_str::<ErrorBody>(&text) {
            Ok(body) => body.error,
            Err(_) if !text.trim().is_empty() => text.trim().to_owned(),
            Err(_) => status.canonical_reason().unwrap_or("error").to_owned(),
        };
        Err(ClientError::Api { status, message })
    }

    async fn json<T: DeserializeOwned>(&self, request: RequestBuilder) -> Result<T> {
        Ok(self.send(request).await?.json().await?)
    }
}

/// Minimal Server-Sent Events parser: yields the `data` of each event.
#[derive(Default)]
struct SseParser {
    line: Vec<u8>,
    data: String,
    has_data: bool,
}

impl SseParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &byte in chunk {
            if byte != b'\n' {
                self.line.push(byte);
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            let line = String::from_utf8_lossy(&self.line).into_owned();
            self.line.clear();
            if line.is_empty() {
                if self.has_data {
                    out.push(std::mem::take(&mut self.data));
                    self.has_data = false;
                }
            } else if let Some(value) = line.strip_prefix("data") {
                // Other fields (`id`, `event`, `retry`) and `:` comments are ignored.
                let Some(value) = value.strip_prefix(':').or(value.is_empty().then_some("")) else {
                    continue;
                };
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
                self.has_data = true;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_handles_split_chunks_and_comments() {
        let mut p = SseParser::default();
        assert!(p.feed(b": keep-alive\n\nid: 1\nda").is_empty());
        assert_eq!(
            p.feed(b"ta: {\"a\":\r\ndata: 1}\r\n\r\n"),
            vec!["{\"a\":\n1}"]
        );
        assert_eq!(p.feed(b"data:x\n\ndata\n\n"), vec!["x", ""]);
    }

    #[test]
    fn builds_urls_under_api() {
        let c = ApiClient::new("http://127.0.0.1:7878/", "t").unwrap();
        assert_eq!(
            c.url(&["modules", "platform.discord.bot", "enable"])
                .as_str(),
            "http://127.0.0.1:7878/api/modules/platform.discord.bot/enable"
        );
        assert!(ApiClient::new("not a url", "t").is_err());
    }
}
