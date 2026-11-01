//! Typed client for the admin API, used by the CLI.

use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use futures::StreamExt;
use futures::stream::BoxStream;
use miyoria_stage::StreamAction;
use miyoria_store::{DecisionRecord, PersonaOverride, RoleAssignment, RoleDefinition, RoleMapping};
use miyoria_types::{ContextKey, Envelope, PlatformId};
use reqwest::{Method, RequestBuilder, Response, StatusCode, Url};
use serde::de::DeserializeOwned;

use crate::types::{
    AdjustPersonRequest, AssignRoleRequest, CostInfo, ErrorBody, ExpressionRequest, ExtensionInfo,
    HealthInfo, McpServerInfo, MemoryItem, MemoryListQuery, MemoryRecordView, ModuleInfo,
    MoveRequest, Page, PersonDetail, PersonSummary, PersonaSectionInfo, QueueState,
    RemoveMappingRequest, SayRequest, SayResponse, SceneRequest, SetPersonaRequest,
    SetPersonaResponse, StageState, StreamRequest, UpdateMemoryRequest, UpdatePersonRequest,
    UpsertRoleRequest, UsageInfo, VoiceState,
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

    /// Spend today and this month per model, plus the budget state.
    pub async fn cost(&self) -> Result<CostInfo> {
        self.json(self.request(Method::GET, &["llm", "cost"])).await
    }

    // ----- people -----

    /// People with a relationship, most recent interaction first. `q`
    /// filters by name or account id; `cursor` is a previous `next_cursor`.
    pub async fn people(
        &self,
        q: Option<&str>,
        limit: Option<usize>,
        cursor: Option<&str>,
    ) -> Result<Page<PersonSummary>> {
        let mut url = self.url(&["people"]);
        {
            let mut pairs = url.query_pairs_mut();
            if let Some(q) = q {
                pairs.append_pair("q", q);
            }
            if let Some(limit) = limit {
                pairs.append_pair("limit", &limit.to_string());
            }
            if let Some(cursor) = cursor {
                pairs.append_pair("cursor", cursor);
            }
        }
        self.json(self.http.get(url)).await
    }

    pub async fn person(&self, id: &str) -> Result<PersonDetail> {
        self.json(self.request(Method::GET, &["people", id])).await
    }

    pub async fn update_person(
        &self,
        id: &str,
        request: &UpdatePersonRequest,
    ) -> Result<PersonSummary> {
        self.json(self.request(Method::PATCH, &["people", id]).json(request))
            .await
    }

    /// Adds `affinity` directly (ignoring the daily caps).
    pub async fn adjust_person(&self, id: &str, affinity: f32) -> Result<PersonSummary> {
        let request = AdjustPersonRequest { affinity };
        self.json(
            self.request(Method::POST, &["people", id, "adjust"])
                .json(&request),
        )
        .await
    }

    // ----- memory -----

    /// Lists (newest first) or, with `q`, searches her memories.
    pub async fn memory(&self, query: &MemoryListQuery) -> Result<Page<MemoryItem>> {
        let mut url = self.url(&["memory"]);
        {
            let mut pairs = url.query_pairs_mut();
            if let Some(q) = &query.q {
                pairs.append_pair("q", q);
            }
            if let Some(kind) = query.kind
                && let Ok(serde_json::Value::String(kind)) = serde_json::to_value(kind)
            {
                pairs.append_pair("kind", &kind);
            }
            if let Some(subject) = query.subject {
                pairs.append_pair("subject", &subject.to_string());
            }
            if let Some(before) = query.before {
                pairs.append_pair("before", &before.to_rfc3339());
            }
            if query.include_superseded {
                pairs.append_pair("include_superseded", "true");
            }
            if let Some(limit) = query.limit {
                pairs.append_pair("limit", &limit.to_string());
            }
        }
        self.json(self.http.get(url)).await
    }

    pub async fn update_memory(
        &self,
        id: &str,
        request: &UpdateMemoryRequest,
    ) -> Result<MemoryRecordView> {
        self.json(self.request(Method::PATCH, &["memory", id]).json(request))
            .await
    }

    pub async fn delete_memory(&self, id: &str) -> Result<()> {
        self.empty(self.request(Method::DELETE, &["memory", id]))
            .await
    }

    // ----- roles & permissions -----

    /// Every role, highest rank first.
    pub async fn roles(&self) -> Result<Vec<RoleDefinition>> {
        self.json(self.request(Method::GET, &["auth", "roles"]))
            .await
    }

    pub async fn role(&self, name: &str) -> Result<RoleDefinition> {
        self.json(self.request(Method::GET, &["auth", "roles", name]))
            .await
    }

    /// Creates or replaces a role.
    pub async fn upsert_role(
        &self,
        name: &str,
        request: &UpsertRoleRequest,
    ) -> Result<RoleDefinition> {
        self.json(
            self.request(Method::PUT, &["auth", "roles", name])
                .json(request),
        )
        .await
    }

    pub async fn delete_role(&self, name: &str) -> Result<()> {
        self.empty(self.request(Method::DELETE, &["auth", "roles", name]))
            .await
    }

    pub async fn assignments(&self) -> Result<Vec<RoleAssignment>> {
        self.json(self.request(Method::GET, &["auth", "assignments"]))
            .await
    }

    pub async fn assign_role(&self, request: &AssignRoleRequest) -> Result<RoleAssignment> {
        self.json(
            self.request(Method::POST, &["auth", "assignments"])
                .json(request),
        )
        .await
    }

    pub async fn revoke_role(&self, request: &AssignRoleRequest) -> Result<()> {
        self.empty(
            self.request(Method::DELETE, &["auth", "assignments"])
                .json(request),
        )
        .await
    }

    /// Platform role mappings of one guild.
    pub async fn mappings(&self, platform: &PlatformId, guild: &str) -> Result<Vec<RoleMapping>> {
        let mut url = self.url(&["auth", "mappings"]);
        url.query_pairs_mut()
            .append_pair("platform", platform.as_str())
            .append_pair("guild", guild);
        self.json(self.http.get(url)).await
    }

    pub async fn set_mapping(&self, mapping: &RoleMapping) -> Result<RoleMapping> {
        self.json(
            self.request(Method::PUT, &["auth", "mappings"])
                .json(mapping),
        )
        .await
    }

    pub async fn remove_mapping(&self, request: &RemoveMappingRequest) -> Result<()> {
        self.empty(
            self.request(Method::DELETE, &["auth", "mappings"])
                .json(request),
        )
        .await
    }

    // ----- extensions & MCP -----

    pub async fn extensions(&self) -> Result<Vec<ExtensionInfo>> {
        self.json(self.request(Method::GET, &["extensions"])).await
    }

    /// `action` is `"enable"`, `"disable"` or `"restart"`.
    pub async fn extension_action(&self, id: &str, action: &str) -> Result<ExtensionInfo> {
        self.json(self.request(Method::POST, &["extensions", id, action]))
            .await
    }

    pub async fn mcp_servers(&self) -> Result<Vec<McpServerInfo>> {
        self.json(self.request(Method::GET, &["mcp"])).await
    }

    /// Only `"restart"` is supported at runtime.
    pub async fn mcp_action(&self, name: &str, action: &str) -> Result<McpServerInfo> {
        self.json(self.request(Method::POST, &["mcp", name, action]))
            .await
    }

    // ----- request queue -----

    pub async fn queue(&self) -> Result<QueueState> {
        self.json(self.request(Method::GET, &["queue"])).await
    }

    pub async fn queue_skip(&self, id: &str) -> Result<QueueState> {
        self.json(self.request(Method::POST, &["queue", id, "skip"]))
            .await
    }

    /// Moves an item to a 0-based index of [`QueueState::items`].
    pub async fn queue_move(&self, id: &str, position: usize) -> Result<QueueState> {
        self.json(
            self.request(Method::POST, &["queue", id, "move"])
                .json(&MoveRequest { position }),
        )
        .await
    }

    pub async fn queue_pause(&self, paused: bool) -> Result<QueueState> {
        let action = if paused { "pause" } else { "resume" };
        self.json(self.request(Method::POST, &["queue", action]))
            .await
    }

    // ----- stage & voice -----

    pub async fn stage(&self) -> Result<StageState> {
        self.json(self.request(Method::GET, &["stage"])).await
    }

    pub async fn stage_scene(&self, scene: &str) -> Result<StageState> {
        let request = SceneRequest {
            scene: scene.to_owned(),
        };
        self.json(
            self.request(Method::POST, &["stage", "scene"])
                .json(&request),
        )
        .await
    }

    pub async fn stage_expression(&self, expression: &str) -> Result<StageState> {
        let request = ExpressionRequest {
            expression: expression.to_owned(),
        };
        self.json(
            self.request(Method::POST, &["stage", "expression"])
                .json(&request),
        )
        .await
    }

    pub async fn stage_stream(&self, action: StreamAction) -> Result<StageState> {
        self.json(
            self.request(Method::POST, &["stage", "stream"])
                .json(&StreamRequest { action }),
        )
        .await
    }

    /// Speaks `text` in her voice channel without the LLM.
    pub async fn stage_say(&self, text: &str, emotion: Option<&str>) -> Result<SayResponse> {
        let request = SayRequest {
            text: text.to_owned(),
            emotion: emotion.map(str::to_owned),
        };
        self.json(self.request(Method::POST, &["stage", "say"]).json(&request))
            .await
    }

    pub async fn voice(&self) -> Result<VoiceState> {
        self.json(self.request(Method::GET, &["voice"])).await
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

    /// For routes answering `204 No Content`.
    async fn empty(&self, request: RequestBuilder) -> Result<()> {
        self.send(request).await?.bytes().await?;
        Ok(())
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
