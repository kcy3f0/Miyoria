//! LLM interface.
//!
//! * [`ChatProvider`] is implemented by provider crates (e.g. `miyoria-llm-openai`).
//! * [`LlmRouter`] maps a *purpose* (`chat`, `fast`, `summarizer`, `game`,
//!   `vision`, ...) to a fallback chain of `provider:model` references.
//! * [`LlmModule`] builds providers from `[llm]` config through registered
//!   [`ProviderFactory`]s and provides the router as a service.

mod cost;
mod mock;
mod module;
mod router;
mod types;

pub use cost::{
    BUDGET_TOPIC, BudgetConfig, BudgetState, CostReport, EventSink, ModelUsage, OnExhausted,
    PeriodReport, Pricing, USAGE_KEY_PREFIX, USAGE_PROFILE,
};
pub use mock::MockProvider;
pub use module::{LlmConfig, LlmModule, ProviderConfig, ProviderFactory};
pub use router::{LlmRouter, UsageRecord};
pub use types::*;
