//! Wire types shared by the server and the [client](crate::client).

use miyoria_kernel::ModuleStatus;
use miyoria_llm::UsageRecord;
use miyoria_types::{ModuleId, ModuleStateKind};
use serde::{Deserialize, Serialize};

/// `GET /api/health`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthInfo {
    pub status: String,
    pub version: String,
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
