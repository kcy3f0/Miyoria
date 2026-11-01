use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use parking_lot::RwLock;
use serde::Serialize;
use tracing::warn;

use crate::cost::{BudgetConfig, BudgetState, CostReport, CostTracker, EventSink, Pricing};
use crate::types::{
    ChatProvider, ChatRequest, ChatResponse, ChatStream, ModelRef, StreamEvent, Usage,
};

#[derive(Clone, Debug, Default, Serialize)]
pub struct UsageRecord {
    pub calls: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_prompt_tokens: u64,
}

impl UsageRecord {
    fn add(&mut self, usage: &Usage) {
        self.calls += 1;
        self.prompt_tokens += u64::from(usage.prompt_tokens);
        self.completion_tokens += u64::from(usage.completion_tokens);
        self.cached_prompt_tokens += u64::from(usage.cached_prompt_tokens.unwrap_or(0));
    }
}

/// Routes requests by purpose to a chain of models, falling back to the next
/// model if one fails before producing any output.
pub struct LlmRouter {
    providers: HashMap<String, Arc<dyn ChatProvider>>,
    purposes: RwLock<HashMap<String, Vec<ModelRef>>>,
    usage: Arc<RwLock<HashMap<String, UsageRecord>>>,
    cost: Arc<CostTracker>,
}

impl LlmRouter {
    pub fn new(
        providers: HashMap<String, Arc<dyn ChatProvider>>,
        purposes: HashMap<String, Vec<ModelRef>>,
    ) -> Self {
        Self {
            providers,
            purposes: RwLock::new(purposes),
            usage: Arc::default(),
            cost: Arc::new(CostTracker::new(HashMap::new(), BudgetConfig::default())),
        }
    }

    /// Sets model prices and the budget. Call before the router is shared.
    #[must_use]
    pub fn with_cost(mut self, pricing: HashMap<String, Pricing>, budget: BudgetConfig) -> Self {
        self.cost = Arc::new(CostTracker::new(pricing, budget));
        self
    }

    /// Replaces the cost tracker (tests with a fake clock).
    #[cfg(test)]
    fn with_tracker(mut self, tracker: CostTracker) -> Self {
        self.cost = Arc::new(tracker);
        self
    }

    /// Overrides purposes, e.g. with the active profile's `[llm.purposes]`.
    pub fn set_purposes(&self, overrides: HashMap<String, Vec<ModelRef>>) {
        self.purposes.write().extend(overrides);
    }

    pub fn chain(&self, purpose: &str) -> Vec<ModelRef> {
        let purposes = self.purposes.read();
        purposes
            .get(purpose)
            .or_else(|| purposes.get("chat"))
            .cloned()
            .unwrap_or_default()
    }

    /// The purpose whose chain a request for `purpose` uses (`chat` if unconfigured).
    fn effective_purpose(&self, purpose: &str) -> String {
        if self.purposes.read().contains_key(purpose) {
            purpose.to_owned()
        } else {
            "chat".to_owned()
        }
    }

    /// Chain to use for `purpose` in budget `state`: the configured fallback
    /// while degraded or exhausted, else the normal chain.
    fn chain_for_state(&self, purpose: &str, state: BudgetState) -> Vec<ModelRef> {
        if state != BudgetState::Ok {
            let fallback = self
                .cost
                .budget()
                .fallback
                .get(&self.effective_purpose(purpose));
            if let Some(chain) = fallback.filter(|c| !c.is_empty()) {
                return chain.clone();
            }
        }
        self.chain(purpose)
    }

    pub fn has_purpose(&self, purpose: &str) -> bool {
        !self.chain(purpose).is_empty()
    }

    /// Usage per `provider:model` since startup.
    pub fn usage(&self) -> HashMap<String, UsageRecord> {
        self.usage.read().clone()
    }

    /// Spend so far today and this month, per model, plus the budget state.
    pub fn cost_report(&self) -> CostReport {
        self.cost.report()
    }

    /// Current budget state (re-evaluated, so day rollovers are applied).
    pub fn budget_state(&self) -> BudgetState {
        self.cost.state()
    }

    /// Publishes the current budget state as an `llm.budget` event.
    pub fn announce_budget(&self) {
        self.cost.announce();
    }

    /// Where budget events (`llm.budget`) are published.
    pub fn set_event_sink(&self, sink: EventSink) {
        self.cost.set_sink(sink);
    }

    /// Loads persisted usage of the current day and month and enables
    /// [`flush`](Self::flush). Call once, after `set_event_sink`.
    pub async fn attach_store(
        &self,
        store: Arc<dyn miyoria_store::SettingsStore>,
    ) -> anyhow::Result<()> {
        self.cost.attach_store(store).await
    }

    /// Persists unsaved usage totals (no-op without a store).
    pub async fn flush(&self) -> anyhow::Result<()> {
        self.cost.flush().await
    }

    /// Streams a response for `purpose` (falls back to `chat` if the purpose
    /// is not configured). `request.model` is overwritten.
    ///
    /// Fails with `budget exhausted` when the budget is used up and
    /// `on_exhausted = "stop"` (unless the purpose is exempt). While degraded
    /// or exhausted the `[llm.budget.fallback]` chain replaces the normal one.
    pub async fn stream(&self, purpose: &str, request: ChatRequest) -> anyhow::Result<ChatStream> {
        let state = self.cost.gate(purpose)?;
        let chain = self.chain_for_state(purpose, state);
        if chain.is_empty() {
            anyhow::bail!("no model configured for purpose `{purpose}` (and no `chat` fallback)");
        }
        let mut last_err = None;
        for model in chain {
            let Some(provider) = self.providers.get(&model.provider) else {
                warn!(%model, "unknown provider in model chain");
                last_err = Some(anyhow::anyhow!("unknown provider `{}`", model.provider));
                continue;
            };
            let mut req = request.clone();
            req.model.clone_from(&model.model);
            match provider.stream(req).await {
                Ok(mut stream) => {
                    // Only fall back if the model fails before its first event.
                    match stream.next().await {
                        Some(Err(e)) => {
                            warn!(%model, error = %e, "model failed, trying next in chain");
                            last_err = Some(e);
                        }
                        first => {
                            return Ok(self.track(model.to_string(), first, stream));
                        }
                    }
                }
                Err(e) => {
                    warn!(%model, error = %e, "model failed, trying next in chain");
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("all models failed")))
    }

    pub async fn complete(
        &self,
        purpose: &str,
        request: ChatRequest,
    ) -> anyhow::Result<ChatResponse> {
        ChatResponse::collect(self.stream(purpose, request).await?).await
    }

    fn track(
        &self,
        key: String,
        first: Option<anyhow::Result<StreamEvent>>,
        rest: ChatStream,
    ) -> ChatStream {
        let usage = self.usage.clone();
        let cost = self.cost.clone();
        futures::stream::iter(first)
            .chain(rest)
            .inspect(move |ev| {
                if let Ok(StreamEvent::Done { usage: Some(u), .. }) = ev {
                    usage.write().entry(key.clone()).or_default().add(u);
                    cost.record(&key, u);
                }
            })
            .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::MockProvider;
    use crate::types::ChatMessage;

    fn router(primary: MockProvider) -> LlmRouter {
        let mut providers: HashMap<String, Arc<dyn ChatProvider>> = HashMap::new();
        providers.insert("a".into(), Arc::new(primary));
        providers.insert("b".into(), Arc::new(MockProvider::new("b").reply("from b")));
        let mut purposes = HashMap::new();
        purposes.insert(
            "chat".into(),
            vec!["a:m1".parse().unwrap(), "b:m2".parse().unwrap()],
        );
        LlmRouter::new(providers, purposes)
    }

    fn req() -> ChatRequest {
        ChatRequest {
            messages: vec![ChatMessage::user("hi")],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn uses_first_model_and_falls_back_on_error() {
        let r = router(MockProvider::new("a").reply("from a"));
        assert_eq!(r.complete("fast", req()).await.unwrap().text, "from a");

        let r = router(MockProvider::new("a").fail("down"));
        assert_eq!(r.complete("chat", req()).await.unwrap().text, "from b");
        assert_eq!(r.usage()["b:m2"].calls, 1);
    }
}

#[cfg(test)]
mod cost_tests {
    use std::collections::BTreeMap;

    use async_trait::async_trait;
    use chrono::{DateTime, TimeZone, Utc};
    use miyoria_store::SettingsStore;
    use miyoria_types::{Event, ProfileId};
    use parking_lot::Mutex;

    use super::*;
    use crate::cost::{OnExhausted, USAGE_PROFILE};
    use crate::mock::MockProvider;
    use crate::types::ChatMessage;

    /// Settings store backed by a map.
    #[derive(Default)]
    struct FakeStore {
        data: Mutex<BTreeMap<(String, String), serde_json::Value>>,
    }

    #[async_trait]
    impl SettingsStore for FakeStore {
        async fn get(
            &self,
            profile: &ProfileId,
            key: &str,
        ) -> anyhow::Result<Option<serde_json::Value>> {
            let k = (profile.to_string(), key.to_owned());
            Ok(self.data.lock().get(&k).cloned())
        }

        async fn set(
            &self,
            profile: &ProfileId,
            key: &str,
            value: Option<serde_json::Value>,
        ) -> anyhow::Result<()> {
            let k = (profile.to_string(), key.to_owned());
            match value {
                Some(v) => self.data.lock().insert(k, v),
                None => self.data.lock().remove(&k),
            };
            Ok(())
        }

        async fn list(
            &self,
            profile: &ProfileId,
            prefix: &str,
        ) -> anyhow::Result<BTreeMap<String, serde_json::Value>> {
            let profile = profile.to_string();
            Ok(self
                .data
                .lock()
                .iter()
                .filter(|((p, k), _)| *p == profile && k.starts_with(prefix))
                .map(|((_, k), v)| (k.clone(), v.clone()))
                .collect())
        }
    }

    type SharedClock = Arc<Mutex<DateTime<Utc>>>;
    type Events = Arc<Mutex<Vec<serde_json::Value>>>;

    struct Setup {
        router: LlmRouter,
        a: Arc<MockProvider>,
        b: Arc<MockProvider>,
        clock: SharedClock,
        events: Events,
    }

    fn at(y: i32, mo: u32, d: u32, h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, 0, 0).unwrap()
    }

    /// One USD per completion token, so a call with `n` completion tokens costs `n` USD.
    fn dollar_pricing() -> HashMap<String, Pricing> {
        let p = Pricing {
            output_per_mtok: 1_000_000.0,
            ..Default::default()
        };
        HashMap::from([("a:m1".to_owned(), p), ("b:cheap".to_owned(), p)])
    }

    fn provider(name: &str, completion_tokens: u32) -> MockProvider {
        MockProvider::new(name).events(vec![
            StreamEvent::TextDelta(format!("from {name}")),
            StreamEvent::Done {
                finish_reason: Some("stop".into()),
                usage: Some(Usage {
                    prompt_tokens: 10,
                    completion_tokens,
                    cached_prompt_tokens: None,
                }),
            },
        ])
    }

    fn budget(daily: f64) -> BudgetConfig {
        BudgetConfig {
            daily_usd: Some(daily),
            ..Default::default()
        }
    }

    /// Router with `a:m1` (costs `cost` USD per call, used by `chat` and
    /// `fast`) and `b:cheap`, a fake clock and a recorder for `llm.budget` events.
    fn setup(cost: u32, budget: BudgetConfig, start: DateTime<Utc>) -> Setup {
        let a = Arc::new(provider("a", cost));
        let b = Arc::new(provider("b", 1));
        let providers: HashMap<String, Arc<dyn ChatProvider>> = HashMap::from([
            ("a".to_owned(), a.clone() as Arc<dyn ChatProvider>),
            ("b".to_owned(), b.clone() as Arc<dyn ChatProvider>),
        ]);
        let purposes = HashMap::from([
            ("chat".to_owned(), vec!["a:m1".parse().unwrap()]),
            ("fast".to_owned(), vec!["a:m1".parse().unwrap()]),
        ]);
        let clock: SharedClock = Arc::new(Mutex::new(start));
        let c = clock.clone();
        let tracker =
            CostTracker::with_clock(dollar_pricing(), budget, Arc::new(move || *c.lock()));
        let router = LlmRouter::new(providers, purposes).with_tracker(tracker);
        let events: Events = Arc::default();
        let sink = events.clone();
        router.set_event_sink(Arc::new(move |ev| {
            if let Event::Custom { topic, payload } = ev {
                assert_eq!(topic, "llm.budget");
                sink.lock().push(payload);
            }
        }));
        Setup {
            router,
            a,
            b,
            clock,
            events,
        }
    }

    fn req() -> ChatRequest {
        ChatRequest {
            messages: vec![ChatMessage::user("hi")],
            ..Default::default()
        }
    }

    fn states(events: &Events) -> Vec<String> {
        events
            .lock()
            .iter()
            .map(|p| p["state"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn pricing_math_with_cached_tokens() {
        let p = Pricing {
            input_per_mtok: 3.0,
            cached_input_per_mtok: Some(0.3),
            output_per_mtok: 15.0,
        };
        let usage = Usage {
            prompt_tokens: 1_000_000,
            completion_tokens: 100_000,
            cached_prompt_tokens: Some(400_000),
        };
        // 600k * 3 + 400k * 0.3 + 100k * 15, per million.
        assert!((p.cost(&usage) - 3.42).abs() < 1e-9);

        // Without a cached price the input price applies; over-reported
        // cached tokens are clamped to the prompt size.
        let p = Pricing {
            input_per_mtok: 2.0,
            output_per_mtok: 0.0,
            ..Default::default()
        };
        let usage = Usage {
            prompt_tokens: 500_000,
            completion_tokens: 0,
            cached_prompt_tokens: Some(900_000),
        };
        assert!((p.cost(&usage) - 1.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn tracks_cost_per_model_and_ignores_unpriced_models() {
        let s = setup(3, BudgetConfig::default(), at(2026, 3, 10, 0));
        let r = &s.router;
        r.complete("chat", req()).await.unwrap();
        r.complete("chat", req()).await.unwrap();
        let report = r.cost_report();
        assert_eq!(report.today.period, "2026-03-10");
        assert_eq!(report.month.period, "2026-03");
        assert!((report.today.total_usd - 6.0).abs() < 1e-9);
        assert_eq!(report.today.models["a:m1"].calls, 2);
        assert_eq!(report.month.models["a:m1"].completion_tokens, 6);
        assert_eq!(r.usage()["a:m1"].calls, 2);
        assert_eq!(report.state, BudgetState::Ok);

        // A model without pricing costs 0 and is only warned about once.
        let t = CostTracker::new(HashMap::new(), BudgetConfig::default());
        let u = Usage {
            prompt_tokens: 100,
            completion_tokens: 100,
            cached_prompt_tokens: None,
        };
        t.record("x:y", &u);
        t.record("x:y", &u);
        let report = t.report();
        assert_eq!(report.today.total_usd, 0.0);
        assert_eq!(report.today.models["x:y"].calls, 2);
        assert_eq!(t.unpriced_logged.lock().len(), 1);
    }

    #[tokio::test]
    async fn degrades_then_exhausts_and_stops() {
        let mut cfg = budget(10.0);
        cfg.budget_exempt_purposes = vec!["fast".into()];
        let s = setup(4, cfg, at(2026, 3, 10, 0));
        let r = &s.router;

        r.complete("chat", req()).await.unwrap(); // 4
        assert_eq!(r.budget_state(), BudgetState::Ok);
        assert!(s.events.lock().is_empty());

        r.complete("chat", req()).await.unwrap(); // 8 = 80%
        assert_eq!(r.budget_state(), BudgetState::Degraded);
        r.complete("chat", req()).await.unwrap(); // 12
        assert_eq!(r.budget_state(), BudgetState::Exhausted);
        assert_eq!(states(&s.events), ["degraded", "exhausted"]);

        let last = s.events.lock().last().cloned().unwrap();
        assert_eq!(last["daily_usd"], 10.0);
        assert!(last["monthly_usd"].is_null());
        assert_eq!(last["spent_today_usd"], 12.0);
        assert_eq!(last["spent_month_usd"], 12.0);

        let err = r.complete("chat", req()).await.unwrap_err();
        assert_eq!(err.to_string(), "budget exhausted");
        let err = r.stream("nonexistent", req()).await.err().unwrap();
        assert_eq!(err.to_string(), "budget exhausted");
        // Exempt purposes keep working.
        assert_eq!(r.complete("fast", req()).await.unwrap().text, "from a");
        // No duplicate events for an unchanged state.
        assert_eq!(s.events.lock().len(), 2);
    }

    #[tokio::test]
    async fn monthly_limit_counts_too() {
        let cfg = BudgetConfig {
            monthly_usd: Some(10.0),
            ..Default::default()
        };
        let s = setup(9, cfg, at(2026, 3, 10, 0));
        let r = &s.router;
        r.complete("chat", req()).await.unwrap();
        assert_eq!(r.budget_state(), BudgetState::Degraded);
        // The next day the daily total resets but the month does not.
        *s.clock.lock() = at(2026, 3, 11, 0);
        r.complete("chat", req()).await.unwrap();
        assert_eq!(r.budget_state(), BudgetState::Exhausted);
        let report = r.cost_report();
        assert!((report.today.total_usd - 9.0).abs() < 1e-9);
        assert!((report.month.total_usd - 18.0).abs() < 1e-9);
        assert!(states(&s.events).contains(&"exhausted".to_owned()));
    }

    #[tokio::test]
    async fn rollover_restores_ok_and_uses_timezone() {
        // 2026-03-10 17:00 UTC is already 03-11 in UTC+8.
        let s = setup(12, budget(10.0), at(2026, 3, 10, 17));
        let r = &s.router;
        r.complete("chat", req()).await.unwrap();
        assert_eq!(r.cost_report().today.period, "2026-03-11");
        assert_eq!(r.budget_state(), BudgetState::Exhausted);
        assert!(r.stream("chat", req()).await.is_err());

        // 15:00 UTC the next day is still 03-11 locally; 16:00 UTC is 03-12.
        *s.clock.lock() = at(2026, 3, 11, 15);
        assert_eq!(r.budget_state(), BudgetState::Exhausted);
        *s.clock.lock() = at(2026, 3, 11, 16);
        assert_eq!(r.budget_state(), BudgetState::Ok);
        assert_eq!(states(&s.events), ["exhausted", "ok"]);
        assert!(r.complete("chat", req()).await.is_ok());

        let report = r.cost_report();
        assert_eq!(report.today.period, "2026-03-12");
        assert!((report.today.total_usd - 12.0).abs() < 1e-9);
        assert!((report.month.total_usd - 24.0).abs() < 1e-9);

        // Month rollover clears the month totals.
        *s.clock.lock() = at(2026, 3, 31, 16);
        let report = r.cost_report();
        assert_eq!(report.month.period, "2026-04");
        assert_eq!(report.month.total_usd, 0.0);
        assert_eq!(report.today.total_usd, 0.0);
    }

    #[tokio::test]
    async fn persistence_round_trip() {
        let store = Arc::new(FakeStore::default());
        let profile = ProfileId::from(USAGE_PROFILE);
        let s = setup(3, budget(100.0), at(2026, 3, 10, 0));
        s.router.attach_store(store.clone()).await.unwrap();
        s.router.complete("chat", req()).await.unwrap();
        s.router.complete("chat", req()).await.unwrap();
        s.router.flush().await.unwrap();

        let keys: Vec<_> = store
            .list(&profile, "llm_usage:")
            .await
            .unwrap()
            .into_keys()
            .collect();
        assert_eq!(keys, ["llm_usage:2026-03", "llm_usage:2026-03-10"]);

        // A new router (restart) picks the totals up and keeps adding to them.
        let s2 = setup(3, budget(7.0), at(2026, 3, 10, 5));
        s2.router.attach_store(store.clone()).await.unwrap();
        let report = s2.router.cost_report();
        assert!((report.today.total_usd - 6.0).abs() < 1e-9);
        assert_eq!(report.today.models["a:m1"].calls, 2);
        // 6 of 7 is above the 80% line: the loaded state was published.
        assert_eq!(report.state, BudgetState::Degraded);
        assert_eq!(states(&s2.events), ["degraded"]);
        s2.router.complete("chat", req()).await.unwrap();
        s2.router.flush().await.unwrap();
        let doc = store
            .get(&profile, "llm_usage:2026-03-10")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(doc["models"]["a:m1"]["calls"], 3);
        assert_eq!(doc["models"]["a:m1"]["cost_usd"], 9.0);

        // Rolling over still writes the finished day's last totals.
        let s3 = setup(3, budget(100.0), at(2026, 3, 10, 6));
        s3.router.attach_store(store.clone()).await.unwrap();
        s3.router.complete("chat", req()).await.unwrap();
        *s3.clock.lock() = at(2026, 3, 11, 6);
        s3.router.complete("chat", req()).await.unwrap();
        s3.router.flush().await.unwrap();
        let old = store
            .get(&profile, "llm_usage:2026-03-10")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(old["models"]["a:m1"]["calls"], 4);
        let new = store
            .get(&profile, "llm_usage:2026-03-11")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(new["models"]["a:m1"]["calls"], 1);
    }

    #[tokio::test]
    async fn fallback_chain_used_while_degraded() {
        let mut cfg = budget(20.0);
        cfg.fallback
            .insert("chat".into(), vec!["b:cheap".parse().unwrap()]);
        let s = setup(17, cfg, at(2026, 3, 10, 0));
        let r = &s.router;
        assert_eq!(r.complete("chat", req()).await.unwrap().text, "from a");
        assert_eq!(r.budget_state(), BudgetState::Degraded);

        // Chat is switched to the cheap model; `fast` has no fallback entry.
        assert_eq!(r.complete("chat", req()).await.unwrap().text, "from b");
        assert_eq!(r.complete("unknown", req()).await.unwrap().text, "from b");
        assert_eq!(r.complete("fast", req()).await.unwrap().text, "from a");
        assert_eq!(s.a.requests().len(), 2);
        assert_eq!(s.b.requests().len(), 2);
        assert_eq!(s.b.requests()[0].model, "cheap");
    }

    #[tokio::test]
    async fn on_exhausted_fallback_keeps_running_on_fallback_models() {
        let mut cfg = budget(10.0);
        cfg.on_exhausted = OnExhausted::Fallback;
        cfg.fallback
            .insert("chat".into(), vec!["b:cheap".parse().unwrap()]);
        let s = setup(12, cfg, at(2026, 3, 10, 0));
        let r = &s.router;
        r.complete("chat", req()).await.unwrap();
        assert_eq!(r.budget_state(), BudgetState::Exhausted);
        assert_eq!(r.complete("chat", req()).await.unwrap().text, "from b");
        // No fallback configured for `fast`: it keeps its normal chain.
        assert_eq!(r.complete("fast", req()).await.unwrap().text, "from a");
    }

    #[test]
    fn config_parses_pricing_and_budget() {
        let cfg: crate::LlmConfig = serde_json::from_value(serde_json::json!({
            "pricing": { "deepseek:deepseek-chat": {
                "input_per_mtok": 0.27, "cached_input_per_mtok": 0.07, "output_per_mtok": 1.1 } },
            "budget": {
                "daily_usd": 2.0,
                "on_exhausted": "fallback",
                "fallback": { "chat": ["deepseek:cheap"] },
                "budget_exempt_purposes": ["fast"]
            }
        }))
        .unwrap();
        assert_eq!(cfg.budget.on_exhausted, OnExhausted::Fallback);
        assert_eq!(cfg.budget.degrade_at, 0.8);
        assert_eq!(cfg.budget.timezone_offset_hours, 8.0);
        let price = cfg.pricing["deepseek:deepseek-chat"];
        assert_eq!(price.cached_input_per_mtok, Some(0.07));
        assert!(cfg.budget.monthly_usd.is_none());
    }
}
