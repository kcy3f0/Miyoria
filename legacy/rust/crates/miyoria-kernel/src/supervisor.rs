use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use miyoria_types::{Event, ModuleId, ModuleStateKind};
use serde::Serialize;
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{info, warn};

use crate::bus::EventBus;
use crate::context::{Failure, ModuleContext};
use crate::module::Module;
use crate::services::ServiceRegistry;

const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const RESTART_WINDOW: Duration = Duration::from_secs(600);
const MAX_RESTARTS_IN_WINDOW: usize = 5;
const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
pub struct ModuleStatus {
    pub id: ModuleId,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub state: ModuleStateKind,
    pub reason: Option<String>,
    pub recent_restarts: usize,
}

struct Running {
    cancel: CancellationToken,
    tracker: TaskTracker,
}

struct Slot {
    module: Arc<dyn Module>,
    config: serde_json::Value,
    enabled: bool,
    state: ModuleStateKind,
    reason: Option<String>,
    generation: u64,
    running: Option<Running>,
    restarts: VecDeque<Instant>,
}

struct Inner {
    bus: EventBus,
    services: Arc<ServiceRegistry>,
    slots: Mutex<BTreeMap<ModuleId, Slot>>,
    failures_tx: mpsc::UnboundedSender<Failure>,
    failures_rx: parking_lot::Mutex<Option<mpsc::UnboundedReceiver<Failure>>>,
}

/// Owns every module's lifecycle. Cheap to clone; clones share state.
///
/// Lifecycle operations are serialized. A module must not call back into the
/// supervisor from inside `Module::start` / `Module::stop` (doing so from its
/// spawned tasks is fine).
#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

/// Handle given to modules (e.g. admin commands) that manage other modules.
pub type SupervisorHandle = Supervisor;

impl Supervisor {
    pub fn new(bus: EventBus, services: Arc<ServiceRegistry>) -> Self {
        let (failures_tx, failures_rx) = mpsc::unbounded_channel();
        Self {
            inner: Arc::new(Inner {
                bus,
                services,
                slots: Mutex::new(BTreeMap::new()),
                failures_tx,
                failures_rx: parking_lot::Mutex::new(Some(failures_rx)),
            }),
        }
    }

    pub fn bus(&self) -> &EventBus {
        &self.inner.bus
    }

    pub fn services(&self) -> &Arc<ServiceRegistry> {
        &self.inner.services
    }

    pub async fn register(
        &self,
        module: Arc<dyn Module>,
        config: serde_json::Value,
        enabled: bool,
    ) {
        let id = module.manifest().id.clone();
        let state = if enabled {
            ModuleStateKind::Stopped
        } else {
            ModuleStateKind::Disabled
        };
        self.inner.slots.lock().await.insert(
            id,
            Slot {
                module,
                config,
                enabled,
                state,
                reason: None,
                generation: 0,
                running: None,
                restarts: VecDeque::new(),
            },
        );
    }

    /// Starts every enabled module in dependency order and begins watching
    /// for failures. Call once.
    pub async fn start_all(&self) -> anyhow::Result<()> {
        if let Some(rx) = self.inner.failures_rx.lock().take() {
            tokio::spawn(failure_loop(self.clone(), rx));
        }
        let mut slots = self.inner.slots.lock().await;
        let order = topo_order(&slots)?;
        for id in order {
            self.try_start(&mut slots, &id).await;
        }
        Ok(())
    }

    pub async fn stop_all(&self) {
        let mut slots = self.inner.slots.lock().await;
        let Ok(mut order) = topo_order(&slots) else {
            return;
        };
        order.reverse();
        for id in order {
            let final_state = if slots[&id].enabled {
                ModuleStateKind::Stopped
            } else {
                ModuleStateKind::Disabled
            };
            self.stop_one(&mut slots, &id, final_state, None).await;
        }
    }

    pub async fn list(&self) -> Vec<ModuleStatus> {
        let slots = self.inner.slots.lock().await;
        let now = Instant::now();
        slots
            .iter()
            .map(|(id, s)| {
                let m = s.module.manifest();
                ModuleStatus {
                    id: id.clone(),
                    name: m.name.clone(),
                    description: m.description.clone(),
                    enabled: s.enabled,
                    state: s.state,
                    reason: s.reason.clone(),
                    recent_restarts: s
                        .restarts
                        .iter()
                        .filter(|t| now.duration_since(**t) < RESTART_WINDOW)
                        .count(),
                }
            })
            .collect()
    }

    pub async fn enable(&self, id: &ModuleId) -> anyhow::Result<()> {
        let mut slots = self.inner.slots.lock().await;
        let slot = slots
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("unknown module `{id}`"))?;
        slot.enabled = true;
        slot.restarts.clear();
        if slot.running.is_none() {
            slot.state = ModuleStateKind::Stopped;
        }
        self.start_pending(&mut slots).await;
        let slot = &slots[id];
        if slot.state == ModuleStateKind::Running {
            Ok(())
        } else {
            anyhow::bail!(
                "module `{id}` did not start: {}",
                slot.reason.as_deref().unwrap_or("unknown reason")
            )
        }
    }

    pub async fn disable(&self, id: &ModuleId) -> anyhow::Result<()> {
        let mut slots = self.inner.slots.lock().await;
        if !slots.contains_key(id) {
            anyhow::bail!("unknown module `{id}`");
        }
        for dep in dependents(&slots, id) {
            self.stop_one(
                &mut slots,
                &dep,
                ModuleStateKind::Stopped,
                Some(format!("dependency `{id}` disabled")),
            )
            .await;
        }
        if let Some(slot) = slots.get_mut(id) {
            slot.enabled = false;
        }
        self.stop_one(&mut slots, id, ModuleStateKind::Disabled, None)
            .await;
        Ok(())
    }

    pub async fn restart(&self, id: &ModuleId) -> anyhow::Result<()> {
        {
            let mut slots = self.inner.slots.lock().await;
            let slot = slots
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("unknown module `{id}`"))?;
            if !slot.enabled {
                anyhow::bail!("module `{id}` is disabled");
            }
            slot.restarts.clear();
            self.stop_with_dependents(&mut slots, id, None).await;
        }
        self.enable(id).await
    }

    async fn handle_failure(&self, failure: Failure) {
        let mut slots = self.inner.slots.lock().await;
        let Some(slot) = slots.get_mut(&failure.module) else {
            return;
        };
        if slot.generation != failure.generation || slot.running.is_none() {
            return; // stale report from a previous run
        }
        let now = Instant::now();
        slot.restarts
            .retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        slot.restarts.push_back(now);
        let attempts = slot.restarts.len();
        let generation = slot.generation;

        let id = failure.module.clone();
        self.stop_with_dependents(&mut slots, &id, Some(failure.error.clone()))
            .await;
        if let Some(slot) = slots.get_mut(&id) {
            slot.state = ModuleStateKind::Failed;
            slot.reason = Some(failure.error.clone());
        }
        self.emit(&id, ModuleStateKind::Failed, Some(failure.error));

        if attempts > MAX_RESTARTS_IN_WINDOW {
            warn!(module = %id, "too many failures, giving up until manually restarted");
            return;
        }
        let backoff = Duration::from_secs(1u64 << attempts.min(6)).min(MAX_BACKOFF);
        info!(module = %id, ?backoff, attempts, "scheduling restart");
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(backoff).await;
            let mut slots = this.inner.slots.lock().await;
            let still_failed = slots.get(&id).is_some_and(|s| {
                s.enabled && s.state == ModuleStateKind::Failed && s.generation == generation
            });
            if still_failed {
                if let Some(slot) = slots.get_mut(&id) {
                    slot.state = ModuleStateKind::Stopped;
                }
                this.start_pending(&mut slots).await;
            }
        });
    }

    /// Starts every enabled, stopped module whose requirements are running.
    async fn start_pending(&self, slots: &mut BTreeMap<ModuleId, Slot>) {
        let Ok(order) = topo_order(slots) else {
            return;
        };
        for id in order {
            let s = &slots[&id];
            if s.enabled && s.running.is_none() && s.state != ModuleStateKind::Failed {
                self.try_start(slots, &id).await;
            }
        }
    }

    async fn try_start(&self, slots: &mut BTreeMap<ModuleId, Slot>, id: &ModuleId) {
        let slot = &slots[id];
        if !slot.enabled || slot.running.is_some() {
            return;
        }
        let missing = slot
            .module
            .manifest()
            .requires
            .iter()
            .find(|r| {
                slots
                    .get(*r)
                    .is_none_or(|s| s.state != ModuleStateKind::Running)
            })
            .cloned();
        if let Some(missing) = missing {
            let reason = format!("required module `{missing}` is not running");
            let slot = slots.get_mut(id).expect("slot exists");
            slot.state = ModuleStateKind::Stopped;
            slot.reason = Some(reason.clone());
            self.emit(id, ModuleStateKind::Stopped, Some(reason));
            return;
        }

        let slot = slots.get_mut(id).expect("slot exists");
        slot.generation += 1;
        slot.state = ModuleStateKind::Starting;
        slot.reason = None;
        let running = Running {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        let ctx = ModuleContext {
            id: id.clone(),
            generation: slot.generation,
            bus: self.inner.bus.clone(),
            services: self.inner.services.clone(),
            config: slot.config.clone(),
            cancel: running.cancel.clone(),
            tracker: running.tracker.clone(),
            failures: self.inner.failures_tx.clone(),
        };
        let generation = slot.generation;
        let module = slot.module.clone();
        slot.running = Some(running);
        self.emit(id, ModuleStateKind::Starting, None);

        match module.start(ctx).await {
            Ok(()) => {
                let slot = slots.get_mut(id).expect("slot exists");
                slot.state = ModuleStateKind::Running;
                info!(module = %id, "module running");
                self.emit(id, ModuleStateKind::Running, None);
            }
            Err(e) => {
                let _ = self.inner.failures_tx.send(Failure {
                    module: id.clone(),
                    generation,
                    error: format!("start failed: {e:#}"),
                });
            }
        }
    }

    async fn stop_with_dependents(
        &self,
        slots: &mut BTreeMap<ModuleId, Slot>,
        id: &ModuleId,
        reason: Option<String>,
    ) {
        for dep in dependents(slots, id) {
            self.stop_one(
                slots,
                &dep,
                ModuleStateKind::Stopped,
                Some(format!("dependency `{id}` stopped")),
            )
            .await;
        }
        self.stop_one(slots, id, ModuleStateKind::Stopped, reason)
            .await;
    }

    async fn stop_one(
        &self,
        slots: &mut BTreeMap<ModuleId, Slot>,
        id: &ModuleId,
        final_state: ModuleStateKind,
        reason: Option<String>,
    ) {
        let Some(slot) = slots.get_mut(id) else {
            return;
        };
        if let Some(running) = slot.running.take() {
            slot.state = ModuleStateKind::Stopping;
            self.emit(id, ModuleStateKind::Stopping, None);
            if let Err(e) = slot.module.stop().await {
                warn!(module = %id, error = %e, "module stop hook failed");
            }
            running.cancel.cancel();
            running.tracker.close();
            if tokio::time::timeout(STOP_TIMEOUT, running.tracker.wait())
                .await
                .is_err()
            {
                warn!(module = %id, "module tasks did not stop in time");
            }
            self.inner.services.remove_owned_by(id);
        }
        slot.state = final_state;
        slot.reason = reason.clone();
        self.emit(id, final_state, reason);
    }

    fn emit(&self, id: &ModuleId, state: ModuleStateKind, reason: Option<String>) {
        self.inner.bus.publish(
            &ModuleId::from("kernel"),
            Event::ModuleStateChanged {
                module: id.clone(),
                state,
                reason,
            },
            None,
        );
    }
}

async fn failure_loop(sup: Supervisor, mut rx: mpsc::UnboundedReceiver<Failure>) {
    while let Some(failure) = rx.recv().await {
        sup.handle_failure(failure).await;
    }
}

/// Dependency order over `requires` + `optional` among registered modules.
fn topo_order(slots: &BTreeMap<ModuleId, Slot>) -> anyhow::Result<Vec<ModuleId>> {
    let mut order = Vec::with_capacity(slots.len());
    let mut done = HashSet::new();
    let mut visiting = HashSet::new();

    fn visit(
        id: &ModuleId,
        slots: &BTreeMap<ModuleId, Slot>,
        done: &mut HashSet<ModuleId>,
        visiting: &mut HashSet<ModuleId>,
        order: &mut Vec<ModuleId>,
    ) -> anyhow::Result<()> {
        if done.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.clone()) {
            anyhow::bail!("module dependency cycle involving `{id}`");
        }
        let m = slots[id].module.manifest();
        for dep in m.requires.iter().chain(&m.optional) {
            if slots.contains_key(dep) {
                visit(dep, slots, done, visiting, order)?;
            }
        }
        visiting.remove(id);
        done.insert(id.clone());
        order.push(id.clone());
        Ok(())
    }

    for id in slots.keys() {
        visit(id, slots, &mut done, &mut visiting, &mut order)?;
    }
    Ok(order)
}

/// Modules that (transitively) require `id`, deepest dependents first.
fn dependents(slots: &BTreeMap<ModuleId, Slot>, id: &ModuleId) -> Vec<ModuleId> {
    let mut out = Vec::new();
    let mut frontier = vec![id.clone()];
    while let Some(cur) = frontier.pop() {
        for (other, slot) in slots {
            if slot.module.manifest().requires.contains(&cur) && !out.contains(other) {
                out.push(other.clone());
                frontier.push(other.clone());
            }
        }
    }
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;

    use super::*;
    use crate::module::ModuleManifest;

    struct TestModule {
        manifest: ModuleManifest,
        starts: AtomicUsize,
        fail_first_start: bool,
    }

    impl TestModule {
        fn new(manifest: ModuleManifest) -> Arc<Self> {
            Arc::new(Self {
                manifest,
                starts: AtomicUsize::new(0),
                fail_first_start: false,
            })
        }
    }

    #[async_trait]
    impl Module for TestModule {
        fn manifest(&self) -> &ModuleManifest {
            &self.manifest
        }

        async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
            let n = self.starts.fetch_add(1, Ordering::SeqCst);
            if self.fail_first_start && n == 0 {
                ctx.spawn("boom", async { anyhow::bail!("boom") });
            } else {
                let cancel = ctx.cancellation().clone();
                ctx.spawn("idle", async move {
                    cancel.cancelled().await;
                    Ok(())
                });
            }
            Ok(())
        }
    }

    fn sup() -> Supervisor {
        Supervisor::new(EventBus::default(), Arc::new(ServiceRegistry::new()))
    }

    async fn state(sup: &Supervisor, id: &str) -> ModuleStateKind {
        sup.list()
            .await
            .into_iter()
            .find(|s| s.id.as_str() == id)
            .unwrap()
            .state
    }

    #[tokio::test]
    async fn starts_in_order_and_cascades_disable() {
        let sup = sup();
        let base = TestModule::new(ModuleManifest::new("base", "Base"));
        let top = TestModule::new(ModuleManifest::new("top", "Top").requires("base"));
        sup.register(top.clone(), serde_json::Value::Null, true)
            .await;
        sup.register(base.clone(), serde_json::Value::Null, true)
            .await;
        sup.start_all().await.unwrap();
        assert_eq!(state(&sup, "base").await, ModuleStateKind::Running);
        assert_eq!(state(&sup, "top").await, ModuleStateKind::Running);

        sup.disable(&"base".into()).await.unwrap();
        assert_eq!(state(&sup, "base").await, ModuleStateKind::Disabled);
        assert_eq!(state(&sup, "top").await, ModuleStateKind::Stopped);

        sup.enable(&"base".into()).await.unwrap();
        assert_eq!(state(&sup, "top").await, ModuleStateKind::Running);
        assert_eq!(top.starts.load(Ordering::SeqCst), 2);
        sup.stop_all().await;
    }

    #[tokio::test]
    async fn missing_requirement_keeps_module_stopped() {
        let sup = sup();
        let top = TestModule::new(ModuleManifest::new("top", "Top").requires("base"));
        let base = TestModule::new(ModuleManifest::new("base", "Base"));
        sup.register(top, serde_json::Value::Null, true).await;
        sup.register(base, serde_json::Value::Null, false).await;
        sup.start_all().await.unwrap();
        assert_eq!(state(&sup, "top").await, ModuleStateKind::Stopped);
    }

    #[tokio::test(start_paused = true)]
    async fn failed_task_restarts_with_backoff() {
        let sup = sup();
        let m = Arc::new(TestModule {
            manifest: ModuleManifest::new("flaky", "Flaky"),
            starts: AtomicUsize::new(0),
            fail_first_start: true,
        });
        sup.register(m.clone(), serde_json::Value::Null, true).await;
        sup.start_all().await.unwrap();
        // Let the failing task report, then advance past the backoff.
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(state(&sup, "flaky").await, ModuleStateKind::Failed);
        tokio::time::sleep(Duration::from_secs(5)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(state(&sup, "flaky").await, ModuleStateKind::Running);
        assert_eq!(m.starts.load(Ordering::SeqCst), 2);
    }
}
