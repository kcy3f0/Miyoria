//! Wire types shared by the server and the [client](crate::client).

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use miyoria_kernel::ModuleStatus;
use miyoria_llm::{BudgetState, CostReport, ModelUsage, PeriodReport, UsageRecord};
use miyoria_queue::{ItemState, QueueItem};
use miyoria_stage::StreamAction;
use miyoria_store::{
    AuthScope, MemoryKind, MemoryRecord, MemoryScope, Person, Relationship, RelationshipDelta,
};
use miyoria_types::{
    AccountRef, ContextKey, ModuleId, ModuleStateKind, PersonId, PlatformId, ProfileId, TurnId,
    VoiceParticipant,
};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

/// `GET /api/health`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthInfo {
    pub status: String,
    pub version: String,
}

/// `GET /api/auth/methods`: which panel logins this Core offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthMethods {
    /// The static bearer token always works.
    pub token: bool,
    /// Discord OAuth2 (`[modules.api.discord_oauth]` is configured).
    pub discord: bool,
}

/// `GET /api/auth/session`: who the caller is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    /// `"token"` or `"discord"`.
    pub method: String,
    /// The Discord user; `null` for the bearer token.
    pub user: Option<SessionUser>,
    pub permissions: SessionPermissions,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionUser {
    /// Discord user id.
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPermissions {
    /// May use mutating routes (`admin.panel.write`; always for the token).
    pub write: bool,
}

/// One module as reported by `GET /api/modules`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleInfo {
    pub id: ModuleId,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub state: ModuleStateKind,
    pub reason: Option<String>,
    pub recent_restarts: usize,
}

impl From<ModuleStatus> for ModuleInfo {
    fn from(s: ModuleStatus) -> Self {
        Self {
            id: s.id,
            name: s.name,
            description: s.description,
            enabled: s.enabled,
            state: s.state,
            reason: s.reason,
            recent_restarts: s.recent_restarts,
        }
    }
}

/// Token usage of one `provider:model`, from `GET /api/llm/usage`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageInfo {
    pub calls: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_prompt_tokens: u64,
}

impl From<UsageRecord> for UsageInfo {
    fn from(u: UsageRecord) -> Self {
        Self {
            calls: u.calls,
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            cached_prompt_tokens: u.cached_prompt_tokens,
        }
    }
}

/// One persona section, from `GET /api/persona`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonaSectionInfo {
    pub key: String,
    pub body: String,
}

/// Body of `PUT /api/persona/{key}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetPersonaRequest {
    pub body: String,
    /// Defaults to `"api"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_by: Option<String>,
}

/// Response of `PUT /api/persona/{key}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetPersonaResponse {
    pub key: String,
    pub version: u32,
}

/// Every error response: `{ "error": "..." }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: String,
}

/// Deserializes a present-but-`null` field as `Some(None)`, so "omitted"
/// (`None`) and "cleared" (`Some(None)`) can be told apart.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A page of results. `next_cursor` is opaque; `None` on the last page.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

// ----- LLM cost -------------------------------------------------------------

/// Totals of one day (`YYYY-MM-DD`) or month (`YYYY-MM`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PeriodInfo {
    pub period: String,
    pub total_usd: f64,
    pub calls: u64,
    /// Per `provider:model`.
    pub models: BTreeMap<String, ModelUsage>,
}

impl From<PeriodReport> for PeriodInfo {
    fn from(p: PeriodReport) -> Self {
        Self {
            period: p.period,
            total_usd: p.total_usd,
            calls: p.calls,
            models: p.models,
        }
    }
}

/// `GET /api/llm/cost`: [`CostReport`] as-is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CostInfo {
    pub state: BudgetState,
    pub daily_usd: Option<f64>,
    pub monthly_usd: Option<f64>,
    pub degrade_at: f64,
    pub today: PeriodInfo,
    pub month: PeriodInfo,
}

impl From<CostReport> for CostInfo {
    fn from(r: CostReport) -> Self {
        Self {
            state: r.state,
            daily_usd: r.daily_usd,
            monthly_usd: r.monthly_usd,
            degrade_at: r.degrade_at,
            today: r.today.into(),
            month: r.month.into(),
        }
    }
}

// ----- people ---------------------------------------------------------------

/// `GET /api/people` items.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PersonSummary {
    pub person: Person,
    /// `None` before the first interaction.
    pub relationship: Option<Relationship>,
    /// Short attitude label, e.g. `"朋友"`.
    pub label: Option<String>,
    pub blocked: bool,
}

/// `GET /api/people/{id}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PersonDetail {
    #[serde(flatten)]
    pub summary: PersonSummary,
    /// Oldest first; values are the resulting absolute levels.
    pub history: Vec<RelationshipDelta>,
    pub memory_count: u64,
}

/// Body of `PATCH /api/people/{id}`; omitted fields are unchanged.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdatePersonRequest {
    /// Replaces every tag except `blocked` (use [`blocked`](Self::blocked)).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// `Some(None)` (JSON `null`) clears it.
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub call_name: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<bool>,
}

/// Body of `POST /api/people/{id}/adjust`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AdjustPersonRequest {
    /// Added to the affinity directly, ignoring the daily caps.
    pub affinity: f32,
}

// ----- memory ---------------------------------------------------------------

/// A [`MemoryRecord`] without its search tokens and embedding vector.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryRecordView {
    pub id: Ulid,
    pub profile: ProfileId,
    pub kind: MemoryKind,
    pub scope: MemoryScope,
    pub subjects: Vec<PersonId>,
    pub content: String,
    pub importance: f32,
    pub confidence: f32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_accessed: Option<DateTime<Utc>>,
    pub access_count: u32,
    pub source_context: Option<ContextKey>,
    pub due: Option<DateTime<Utc>>,
    pub done: bool,
    pub superseded_by: Option<Ulid>,
    pub has_embedding: bool,
}

impl From<&MemoryRecord> for MemoryRecordView {
    fn from(r: &MemoryRecord) -> Self {
        Self {
            id: r.id,
            profile: r.profile.clone(),
            kind: r.kind,
            scope: r.scope.clone(),
            subjects: r.subjects.clone(),
            content: r.content.clone(),
            importance: r.importance,
            confidence: r.confidence,
            created_at: r.created_at,
            updated_at: r.updated_at,
            last_accessed: r.last_accessed,
            access_count: r.access_count,
            source_context: r.source_context.clone(),
            due: r.due,
            done: r.done,
            superseded_by: r.superseded_by,
            has_embedding: r.embedding.as_ref().is_some_and(|e| !e.is_empty()),
        }
    }
}

/// `GET /api/memory` items. The scores are present only for a search (`q`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryItem {
    pub record: MemoryRecordView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_score: Option<f32>,
    /// `Some(None)` (JSON `null`) for a search that compared no vectors.
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub vector_score: Option<Option<f32>>,
}

/// Query of `GET /api/memory`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MemoryListQuery {
    /// Search text; `None` lists newest first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MemoryKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<PersonId>,
    /// Only records created before this time (pagination when listing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<DateTime<Utc>>,
    #[serde(default)]
    pub include_superseded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

/// Body of `PATCH /api/memory/{id}`; omitted fields are unchanged.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdateMemoryRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MemoryKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importance: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
}

// ----- roles & permissions --------------------------------------------------

/// Body of `POST` / `DELETE /api/auth/assignments`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignRoleRequest {
    pub account: AccountRef,
    pub role: String,
    pub scope: AuthScope,
}

/// Body of `PUT /api/auth/roles/{name}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpsertRoleRequest {
    pub rank: i32,
    #[serde(default)]
    pub grants: Vec<String>,
    #[serde(default)]
    pub denies: Vec<String>,
}

/// Body of `DELETE /api/auth/mappings`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveMappingRequest {
    pub platform: PlatformId,
    pub guild: String,
    pub platform_role: String,
}

// ----- extensions -----------------------------------------------------------

/// One extension, from `GET /api/extensions`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionInfo {
    pub id: String,
    /// Supervisor module running it (`ext.<id>`).
    pub module: ModuleId,
    pub name: String,
    pub version: String,
    pub description: String,
    /// Extension directory.
    pub source: String,
    pub enabled: bool,
    pub state: ModuleStateKind,
    pub reason: Option<String>,
    /// Granted permissions, e.g. `"tools"`, `"events:game.*"`.
    pub permissions: Vec<String>,
}

// ----- MCP ------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpState {
    Connecting,
    Ready,
    Failed,
    Disabled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpToolInfo {
    /// Registry name (`mcp_<server>_<tool>`).
    pub name: String,
    pub description: String,
}

/// One configured MCP server, from `GET /api/mcp`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerInfo {
    pub name: String,
    /// `"stdio"` or `"http"`.
    pub transport: String,
    /// Command line or URL; `None` while the MCP module does not report it.
    pub target: Option<String>,
    pub enabled: bool,
    pub state: McpState,
    pub error: Option<String>,
    pub tools: Vec<McpToolInfo>,
    /// Tools the server offers before allow / deny filtering.
    pub remote_tool_count: usize,
    /// Permission node required to use the tools.
    pub permission: Option<String>,
    pub reconnects: u32,
}

// ----- request queue --------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueAuthor {
    pub account: AccountRef,
    pub display_name: String,
}

/// One queued request, from `GET /api/queue`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueueItemInfo {
    /// The queue's numeric item id, as a string.
    pub id: String,
    /// Free-form, e.g. `"chat"`, `"song"`, `"game_goal"`.
    pub kind: String,
    pub context: Option<ContextKey>,
    pub author: Option<QueueAuthor>,
    pub text: String,
    pub priority: i32,
    pub enqueued_at: DateTime<Utc>,
    /// `active` items come first, then `pending` ones.
    pub state: ItemState,
    pub votes: u32,
}

impl From<QueueItem> for QueueItemInfo {
    fn from(i: QueueItem) -> Self {
        Self {
            id: i.id.to_string(),
            kind: i.kind,
            context: i.context,
            author: Some(QueueAuthor {
                account: i.requester,
                display_name: i.requester_name,
            }),
            text: i.text,
            priority: i.priority,
            enqueued_at: i.created_at,
            state: i.state,
            votes: i.votes,
        }
    }
}

/// `GET /api/queue` and the response of every queue mutation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueueState {
    pub paused: bool,
    /// In processing order.
    pub items: Vec<QueueItemInfo>,
}

/// Body of `POST /api/queue/{id}/move`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveRequest {
    /// 0-based target index in [`QueueState::items`], clamped.
    pub position: usize,
}

// ----- stage ----------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageLinkState {
    pub connected: bool,
    pub error: Option<String>,
}

/// `GET /api/stage` and the response of stage mutations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageState {
    pub vts: StageLinkState,
    pub obs: StageLinkState,
    pub scene: Option<String>,
    pub scenes: Vec<String>,
    /// Last expression (VTube Studio hotkey) triggered through the API.
    pub expression: Option<String>,
    pub expressions: Vec<String>,
    pub overlay_url: Option<String>,
    /// Her speech is playing.
    pub speaking: bool,
    /// Name of the connected Stage node, `None` while disconnected.
    pub node: Option<String>,
    /// OBS is streaming.
    pub streaming: bool,
}

/// Body of `POST /api/stage/scene`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SceneRequest {
    pub scene: String,
}

/// Body of `POST /api/stage/expression`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpressionRequest {
    pub expression: String,
}

/// Body of `POST /api/stage/stream`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamRequest {
    pub action: StreamAction,
}

/// Body of `POST /api/stage/say`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SayRequest {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emotion: Option<String>,
}

/// Response of `POST /api/stage/say`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SayResponse {
    pub turn: Option<TurnId>,
}

// ----- voice ----------------------------------------------------------------

/// Latency over the recent window; `None` percentiles without samples.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatencyStats {
    pub p50_ms: Option<u32>,
    pub p95_ms: Option<u32>,
    pub samples: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceLatency {
    pub asr: LatencyStats,
    pub llm_first_token: LatencyStats,
    pub tts_first_audio: LatencyStats,
}

/// One voice channel she is in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceSession {
    pub context: ContextKey,
    pub label: Option<String>,
    pub participants: Vec<VoiceParticipant>,
    /// Accounts currently speaking.
    pub speaking: Vec<AccountRef>,
    pub joined_at: DateTime<Utc>,
    pub latency: VoiceLatency,
    pub last_turn: Option<TurnId>,
}

/// `GET /api/voice`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceState {
    pub sessions: Vec<VoiceSession>,
}
