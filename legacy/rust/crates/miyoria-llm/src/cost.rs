//! Cost tracking and budgets: pricing, per day / month totals per model, the
//! `ok -> degraded -> exhausted` state machine and persistence.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, FixedOffset, Utc};
use miyoria_store::SettingsStore;
use miyoria_types::{Event, ProfileId};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::types::{ModelRef, Usage};

/// Profile id under which usage totals are persisted.
pub const USAGE_PROFILE: &str = "_global";
/// Settings-key prefix of persisted usage (`llm_usage:YYYY-MM-DD`, `llm_usage:YYYY-MM`).
pub const USAGE_KEY_PREFIX: &str = "llm_usage:";
/// Topic of the budget state event.
pub const BUDGET_TOPIC: &str = "llm.budget";

/// Receives events the router wants to publish (set by the module).
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

/// Price of a model in USD per million tokens (`[llm.pricing."provider:model"]`).
///
/// `prompt_tokens` is assumed to include the cached tokens (OpenAI / DeepSeek
/// semantics), so the cached part is priced at `cached_input_per_mtok` and the
/// rest at `input_per_mtok`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Pricing {
    pub input_per_mtok: f64,
    /// Price of cache-hit input tokens; defaults to `input_per_mtok`.
    pub cached_input_per_mtok: Option<f64>,
    pub output_per_mtok: f64,
}

impl Pricing {
    /// Cost of one call in USD.
    pub fn cost(&self, usage: &Usage) -> f64 {
        let prompt = f64::from(usage.prompt_tokens);
        let cached = f64::from(
            usage
                .cached_prompt_tokens
                .unwrap_or(0)
                .min(usage.prompt_tokens),
        );
        let cached_price = self.cached_input_per_mtok.unwrap_or(self.input_per_mtok);
        ((prompt - cached) * self.input_per_mtok
            + cached * cached_price
            + f64::from(usage.completion_tokens) * self.output_per_mtok)
            / 1_000_000.0
    }
}

/// What to do when the budget is used up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OnExhausted {
    /// Reject requests (except `budget_exempt_purposes`).
    #[default]
    Stop,
    /// Keep going, using the `fallback` models where configured.
    Fallback,
}

/// `[llm.budget]` config section.
///
/// ```toml
/// [llm.budget]
/// daily_usd = 2.0
/// monthly_usd = 40.0
/// degrade_at = 0.8
/// on_exhausted = "stop"            # or "fallback"
/// budget_exempt_purposes = ["fast"]
/// timezone_offset_hours = 8
///
/// [llm.budget.fallback]            # used while degraded / exhausted
/// chat = ["deepseek:deepseek-chat"]
/// ```
///
/// Limits `<= 0` count as unset.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct BudgetConfig {
    pub daily_usd: Option<f64>,
    pub monthly_usd: Option<f64>,
    /// Fraction of a limit at which the state becomes `degraded`.
    pub degrade_at: f64,
    pub on_exhausted: OnExhausted,
    /// Replacement chains per purpose while degraded or exhausted.
    pub fallback: HashMap<String, Vec<ModelRef>>,
    /// Purposes that may still run when exhausted with `on_exhausted = "stop"`.
    pub budget_exempt_purposes: Vec<String>,
    /// UTC offset (hours) that defines day and month boundaries.
    pub timezone_offset_hours: f64,
}

impl Default for BudgetConfig {
    fn default() -> Self {
        Self {
            daily_usd: None,
            monthly_usd: None,
            degrade_at: 0.8,
            on_exhausted: OnExhausted::Stop,
            fallback: HashMap::new(),
            budget_exempt_purposes: Vec::new(),
            timezone_offset_hours: 8.0,
        }
    }
}

fn limit(v: Option<f64>) -> Option<f64> {
    v.filter(|v| *v > 0.0)
}

/// Budget state machine position.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetState {
    #[default]
    Ok,
    Degraded,
    Exhausted,
}

/// Usage and cost of one model within one period.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelUsage {
    pub calls: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_prompt_tokens: u64,
    pub cost_usd: f64,
}

impl ModelUsage {
    fn add(&mut self, usage: &Usage, cost: f64) {
        self.calls += 1;
        self.prompt_tokens += u64::from(usage.prompt_tokens);
        self.completion_tokens += u64::from(usage.completion_tokens);
        self.cached_prompt_tokens += u64::from(usage.cached_prompt_tokens.unwrap_or(0));
        self.cost_usd += cost;
    }

    fn merge(&mut self, other: &Self) {
        self.calls += other.calls;
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        self.cached_prompt_tokens += other.cached_prompt_tokens;
        self.cost_usd += other.cost_usd;
    }
}

/// Persisted document of one day or month.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct PeriodUsage {
    models: BTreeMap<String, ModelUsage>,
}

impl PeriodUsage {
    fn cost(&self) -> f64 {
        self.models.values().map(|m| m.cost_usd).sum()
    }

    fn calls(&self) -> u64 {
        self.models.values().map(|m| m.calls).sum()
    }

    fn merge(&mut self, other: Self) {
        for (model, usage) in other.models {
            self.models.entry(model).or_default().merge(&usage);
        }
    }

    fn add(&mut self, model: &str, usage: &Usage, cost: f64) {
        self.models
            .entry(model.to_owned())
            .or_default()
            .add(usage, cost);
    }

    fn report(&self, period: &str) -> PeriodReport {
        PeriodReport {
            period: period.to_owned(),
            total_usd: self.cost(),
            calls: self.calls(),
            models: self.models.clone(),
        }
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// Totals of one day (`YYYY-MM-DD`) or month (`YYYY-MM`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PeriodReport {
    pub period: String,
    pub total_usd: f64,
    pub calls: u64,
    /// Per `provider:model`.
    pub models: BTreeMap<String, ModelUsage>,
}

/// Snapshot for the API / CLI.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CostReport {
    pub state: BudgetState,
    pub daily_usd: Option<f64>,
    pub monthly_usd: Option<f64>,
    pub degrade_at: f64,
    pub today: PeriodReport,
    pub month: PeriodReport,
}

struct Inner {
    day: String,
    month: String,
    today: PeriodUsage,
    this_month: PeriodUsage,
    state: BudgetState,
    dirty: bool,
    /// Finished periods still to be written to the store.
    retired: Vec<(String, serde_json::Value)>,
}

type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;

pub(crate) struct CostTracker {
    pricing: HashMap<String, Pricing>,
    budget: BudgetConfig,
    clock: Clock,
    inner: Mutex<Inner>,
    sink: RwLock<Option<EventSink>>,
    store: RwLock<Option<Arc<dyn SettingsStore>>>,
    pub(crate) unpriced_logged: Mutex<HashSet<String>>,
}

impl CostTracker {
    pub(crate) fn new(pricing: HashMap<String, Pricing>, budget: BudgetConfig) -> Self {
        Self::build(pricing, budget, Arc::new(Utc::now))
    }

    #[cfg(test)]
    pub(crate) fn with_clock(
        pricing: HashMap<String, Pricing>,
        budget: BudgetConfig,
        clock: Clock,
    ) -> Self {
        Self::build(pricing, budget, clock)
    }

    fn build(pricing: HashMap<String, Pricing>, budget: BudgetConfig, clock: Clock) -> Self {
        let (day, month) = period_keys(&clock, budget.timezone_offset_hours);
        Self {
            pricing,
            budget,
            clock,
            inner: Mutex::new(Inner {
                day,
                month,
                today: PeriodUsage::default(),
                this_month: PeriodUsage::default(),
                state: BudgetState::Ok,
                dirty: false,
                retired: Vec::new(),
            }),
            sink: RwLock::new(None),
            store: RwLock::new(None),
            unpriced_logged: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn budget(&self) -> &BudgetConfig {
        &self.budget
    }

    pub(crate) fn set_sink(&self, sink: EventSink) {
        *self.sink.write() = Some(sink);
    }

    fn evaluate(&self, today: f64, month: f64) -> BudgetState {
        let mut state = BudgetState::Ok;
        let degrade_at = self.budget.degrade_at.clamp(0.0, 1.0);
        for (spent, cap) in [
            (today, limit(self.budget.daily_usd)),
            (month, limit(self.budget.monthly_usd)),
        ] {
            let Some(cap) = cap else { continue };
            if spent >= cap {
                return BudgetState::Exhausted;
            }
            if spent >= cap * degrade_at {
                state = BudgetState::Degraded;
            }
        }
        state
    }

    /// Applies day / month rollover and re-evaluates the state. Returns true
    /// when something an observer cares about changed.
    fn refresh(&self, inner: &mut Inner) -> bool {
        let (day, month) = period_keys(&self.clock, self.budget.timezone_offset_hours);
        let mut changed = false;
        if day != inner.day {
            let old = std::mem::take(&mut inner.today);
            if !old.models.is_empty() {
                let key = format!("{USAGE_KEY_PREFIX}{}", inner.day);
                inner.retired.push((key, old.to_json()));
            }
            inner.day = day;
            changed = true;
        }
        if month != inner.month {
            let old = std::mem::take(&mut inner.this_month);
            if !old.models.is_empty() {
                let key = format!("{USAGE_KEY_PREFIX}{}", inner.month);
                inner.retired.push((key, old.to_json()));
            }
            inner.month = month;
            changed = true;
        }
        let state = self.evaluate(inner.today.cost(), inner.this_month.cost());
        if state != inner.state {
            info!(from = ?inner.state, to = ?state, "llm budget state changed");
            inner.state = state;
            changed = true;
        }
        changed
    }

    fn payload(&self, inner: &Inner) -> serde_json::Value {
        serde_json::json!({
            "state": inner.state,
            "spent_today_usd": inner.today.cost(),
            "daily_usd": limit(self.budget.daily_usd),
            "spent_month_usd": inner.this_month.cost(),
            "monthly_usd": limit(self.budget.monthly_usd),
        })
    }

    fn emit(&self, payload: serde_json::Value) {
        let sink = self.sink.read().clone();
        if let Some(sink) = sink {
            sink(Event::Custom {
                topic: BUDGET_TOPIC.to_owned(),
                payload,
            });
        }
    }

    /// Publishes the current state unconditionally (e.g. at startup, so
    /// listeners don't assume `ok` after a restart with an exhausted budget).
    pub(crate) fn announce(&self) {
        let payload = {
            let mut inner = self.inner.lock();
            self.refresh(&mut inner);
            self.payload(&inner)
        };
        self.emit(payload);
    }

    /// Refreshes the state (publishing a change) and returns it.
    pub(crate) fn state(&self) -> BudgetState {
        let (state, payload) = {
            let mut inner = self.inner.lock();
            let changed = self.refresh(&mut inner);
            (inner.state, changed.then(|| self.payload(&inner)))
        };
        if let Some(payload) = payload {
            self.emit(payload);
        }
        state
    }

    /// Checks whether `purpose` may run now and returns the current state.
    pub(crate) fn gate(&self, purpose: &str) -> anyhow::Result<BudgetState> {
        let state = self.state();
        if state == BudgetState::Exhausted
            && self.budget.on_exhausted == OnExhausted::Stop
            && !self
                .budget
                .budget_exempt_purposes
                .iter()
                .any(|p| p == purpose)
        {
            anyhow::bail!("budget exhausted");
        }
        Ok(state)
    }

    fn price(&self, model: &str, usage: &Usage) -> f64 {
        if let Some(p) = self.pricing.get(model) {
            return p.cost(usage);
        }
        if self.unpriced_logged.lock().insert(model.to_owned()) {
            warn!(%model, "no [llm.pricing] entry for model, its calls cost 0");
        }
        0.0
    }

    /// Adds one finished call.
    pub(crate) fn record(&self, model: &str, usage: &Usage) {
        let cost = self.price(model, usage);
        let payload = {
            let mut inner = self.inner.lock();
            let rolled = self.refresh(&mut inner);
            inner.today.add(model, usage, cost);
            inner.this_month.add(model, usage, cost);
            inner.dirty = true;
            let state = self.evaluate(inner.today.cost(), inner.this_month.cost());
            let changed = rolled || state != inner.state;
            if state != inner.state {
                info!(from = ?inner.state, to = ?state, "llm budget state changed");
                inner.state = state;
            }
            changed.then(|| self.payload(&inner))
        };
        if let Some(payload) = payload {
            self.emit(payload);
        }
    }

    pub(crate) fn report(&self) -> CostReport {
        let (report, payload) = {
            let mut inner = self.inner.lock();
            let changed = self.refresh(&mut inner);
            let report = CostReport {
                state: inner.state,
                daily_usd: limit(self.budget.daily_usd),
                monthly_usd: limit(self.budget.monthly_usd),
                degrade_at: self.budget.degrade_at,
                today: inner.today.report(&inner.day),
                month: inner.this_month.report(&inner.month),
            };
            (report, changed.then(|| self.payload(&inner)))
        };
        if let Some(payload) = payload {
            self.emit(payload);
        }
        report
    }

    /// Sets the store and merges the persisted totals of the current day and
    /// month into memory. Call once.
    pub(crate) async fn attach_store(&self, store: Arc<dyn SettingsStore>) -> anyhow::Result<()> {
        let profile = ProfileId::from(USAGE_PROFILE);
        let (day, month) = {
            let mut inner = self.inner.lock();
            self.refresh(&mut inner);
            (inner.day.clone(), inner.month.clone())
        };
        let load = |key: String| {
            let store = store.clone();
            let profile = profile.clone();
            async move {
                match store.get(&profile, &key).await? {
                    Some(v) => serde_json::from_value::<PeriodUsage>(v)
                        .map_err(|e| anyhow::anyhow!("invalid `{key}`: {e}")),
                    None => Ok(PeriodUsage::default()),
                }
            }
        };
        let day_usage = load(format!("{USAGE_KEY_PREFIX}{day}")).await?;
        let month_usage = load(format!("{USAGE_KEY_PREFIX}{month}")).await?;
        *self.store.write() = Some(store);
        let payload = {
            let mut inner = self.inner.lock();
            // The clock may have crossed a boundary while loading.
            if inner.day == day {
                inner.today.merge(day_usage);
            }
            if inner.month == month {
                inner.this_month.merge(month_usage);
            }
            let changed = self.refresh(&mut inner);
            changed.then(|| self.payload(&inner))
        };
        if let Some(payload) = payload {
            self.emit(payload);
        }
        Ok(())
    }

    /// Writes unsaved totals to the store (no-op without a store or changes).
    /// Failed writes are retried by the next flush.
    pub(crate) async fn flush(&self) -> anyhow::Result<()> {
        let Some(store) = self.store.read().clone() else {
            return Ok(());
        };
        let writes = {
            let mut inner = self.inner.lock();
            let mut writes = std::mem::take(&mut inner.retired);
            if inner.dirty {
                inner.dirty = false;
                writes.push((
                    format!("{USAGE_KEY_PREFIX}{}", inner.day),
                    inner.today.to_json(),
                ));
                writes.push((
                    format!("{USAGE_KEY_PREFIX}{}", inner.month),
                    inner.this_month.to_json(),
                ));
            }
            writes
        };
        let profile = ProfileId::from(USAGE_PROFILE);
        let mut failed = Vec::new();
        let mut first_err = None;
        for (key, value) in writes {
            if let Err(e) = store.set(&profile, &key, Some(value.clone())).await {
                first_err.get_or_insert(e);
                failed.push((key, value));
            }
        }
        match first_err {
            None => Ok(()),
            Some(e) => {
                // Older documents go first so newer snapshots overwrite them.
                let mut inner = self.inner.lock();
                failed.append(&mut inner.retired);
                inner.retired = failed;
                Err(e)
            }
        }
    }
}

/// `(YYYY-MM-DD, YYYY-MM)` of "now" in the configured timezone.
fn period_keys(clock: &Clock, offset_hours: f64) -> (String, String) {
    let secs = (offset_hours * 3600.0).round() as i32;
    let offset = FixedOffset::east_opt(secs).unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
    let now = clock().with_timezone(&offset);
    (
        now.format("%Y-%m-%d").to_string(),
        now.format("%Y-%m").to_string(),
    )
}
