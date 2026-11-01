use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, Utc};
use miyoria_store::SettingsStore;
use miyoria_types::{AccountRef, Event, PlatformId, ProfileId, SocialSignals};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::config::QueueConfig;
use crate::types::{
    Ballot, ItemId, ItemState, QueueError, QueueItem, SubmitRequest, VoteResult, VoteState,
};

/// Settings profile the snapshot is stored under.
pub const STATE_PROFILE: &str = "_global";
/// Settings key of the snapshot.
pub const STATE_KEY: &str = "queue:state";

/// Receives the queue's events (the module publishes them on the bus).
pub type Publisher = Arc<dyn Fn(Event) + Send + Sync>;
/// Time source; replaceable for tests.
pub type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;

/// A new item and where it stands.
#[derive(Clone, Debug, PartialEq)]
pub struct Submitted {
    pub item: QueueItem,
    /// 1-based place among pending items.
    pub position: usize,
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    next_id: ItemId,
    /// Pending and active items, in insertion order.
    #[serde(default)]
    items: Vec<QueueItem>,
    /// Finished items, oldest first.
    #[serde(default)]
    history: Vec<QueueItem>,
    #[serde(default)]
    paused: bool,
    /// How many items each requester got activated (fair queuing credit).
    #[serde(default)]
    served: Vec<(AccountRef, u64)>,
    #[serde(default)]
    vote: Option<VoteState>,
    #[serde(default)]
    last_vote: Option<VoteResult>,
}

impl State {
    fn served_of(&self, account: &AccountRef) -> u64 {
        self.served
            .iter()
            .find(|(a, _)| a == account)
            .map_or(0, |(_, n)| *n)
    }

    fn set_served(&mut self, account: &AccountRef, n: u64) {
        match self.served.iter_mut().find(|(a, _)| a == account) {
            Some((_, v)) => *v = n,
            None => self.served.push((account.clone(), n)),
        }
    }

    fn index_of(&self, id: ItemId) -> Result<usize, QueueError> {
        self.items
            .iter()
            .position(|i| i.id == id)
            .ok_or(QueueError::NotFound(id))
    }

    fn pending_of(&self, account: &AccountRef) -> usize {
        self.items
            .iter()
            .filter(|i| i.state == ItemState::Pending && &i.requester == account)
            .count()
    }

    fn pending_total(&self) -> usize {
        self.items
            .iter()
            .filter(|i| i.state == ItemState::Pending)
            .count()
    }

    /// Fair-queuing catch-up: a requester who had nothing pending starts level
    /// with the least served requester that has something pending.
    fn catch_up(&mut self, account: &AccountRef) {
        if self.pending_of(account) > 0 {
            return;
        }
        let min = self
            .items
            .iter()
            .filter(|i| i.state == ItemState::Pending)
            .map(|i| self.served_of(&i.requester))
            .min();
        if let Some(min) = min {
            if self.served_of(account) < min {
                self.set_served(account, min);
            }
        }
    }

    fn push(&mut self, req: SubmitRequest, now: DateTime<Utc>) -> QueueItem {
        self.next_id += 1;
        let item = QueueItem {
            id: self.next_id,
            requester: req.requester,
            requester_name: req.requester_name,
            kind: req.kind,
            text: req.text,
            context: req.context,
            created_at: now,
            priority: req.priority,
            slot: None,
            votes: 0,
            voters: Vec::new(),
            state: ItemState::Pending,
        };
        self.items.push(item.clone());
        item
    }

    /// Moves the item to history with its final `state`.
    fn finish(&mut self, index: usize, state: ItemState, limit: usize) -> QueueItem {
        let mut item = self.items.remove(index);
        item.state = state;
        self.history.push(item.clone());
        let excess = self.history.len().saturating_sub(limit);
        self.history.drain(..excess);
        item
    }

    /// Ends the vote and returns the result.
    fn close_vote(&mut self, now: DateTime<Utc>) -> Option<VoteResult> {
        let vote = self.vote.take()?;
        let result = VoteResult {
            tallies: vote.tallies(),
            winner: vote.winner(),
            total: vote.ballots.len() as u32,
            options: vote.options,
            ended_at: now,
        };
        self.last_vote = Some(result.clone());
        Some(result)
    }
}

/// What a mutation did: events to publish after the lock is released.
struct Change<R> {
    value: R,
    events: Vec<Event>,
    changed: bool,
}

impl<R> Change<R> {
    fn none(value: R) -> Self {
        Self {
            value,
            events: Vec::new(),
            changed: false,
        }
    }

    fn changed(value: R) -> Self {
        Self {
            value,
            events: Vec::new(),
            changed: true,
        }
    }

    fn with(mut self, event: Event) -> Self {
        self.events.push(event);
        self
    }
}

/// The request queue service (`Arc<RequestQueue>`). All methods are
/// synchronous and quick; only persistence is async.
///
/// Ordering of pending items, first criterion first:
/// 1. `priority` (moderator-set), higher first;
/// 2. manual slot from [`move_item`](Self::move_item);
/// 3. fair lap: the item's place among its requester's own items, plus how
///    many more items that requester got activated than the least served one,
///    so nobody gets two turns before everybody got one;
/// 4. weight: affinity (`dyn SocialSignals`) and upvotes, higher first;
/// 5. age, older first.
pub struct RequestQueue {
    config: QueueConfig,
    state: Mutex<State>,
    social: Option<Arc<dyn SocialSignals>>,
    store: Option<Arc<dyn SettingsStore>>,
    publisher: Option<Publisher>,
    clock: Clock,
    dirty: AtomicBool,
    wake: Notify,
    persist_lock: tokio::sync::Mutex<()>,
}

impl RequestQueue {
    pub fn new(config: QueueConfig) -> Self {
        Self {
            config,
            state: Mutex::new(State::default()),
            social: None,
            store: None,
            publisher: None,
            clock: Arc::new(Utc::now),
            dirty: AtomicBool::new(false),
            wake: Notify::new(),
            persist_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn with_social(mut self, social: Option<Arc<dyn SocialSignals>>) -> Self {
        self.social = social;
        self
    }

    pub fn with_store(mut self, store: Option<Arc<dyn SettingsStore>>) -> Self {
        self.store = store;
        self
    }

    pub fn with_publisher(mut self, publisher: Publisher) -> Self {
        self.publisher = Some(publisher);
        self
    }

    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    pub fn config(&self) -> &QueueConfig {
        &self.config
    }

    // ----- requests -----

    /// Adds a request. Fails when the requester is blocked, has too many
    /// pending requests or the queue is full.
    pub fn submit(&self, mut req: SubmitRequest) -> Result<Submitted, QueueError> {
        req.text = req.text.trim().to_owned();
        if req.text.is_empty() {
            return Err(QueueError::EmptyText);
        }
        if req.text.chars().count() > self.config.max_text_chars {
            return Err(QueueError::TextTooLong(self.config.max_text_chars));
        }
        let kind = req.kind.trim().to_lowercase();
        req.kind = if kind.is_empty() {
            "chat".to_owned()
        } else {
            kind.chars().take(32).collect()
        };
        if self
            .social
            .as_ref()
            .and_then(|s| s.attitude(&req.requester))
            .is_some_and(|a| a.blocked)
        {
            return Err(QueueError::Blocked);
        }
        self.commit(|st, now| {
            if st.pending_total() >= self.config.max_pending {
                return Err(QueueError::QueueFull(self.config.max_pending));
            }
            if st.pending_of(&req.requester) >= self.config.max_pending_per_user {
                return Err(QueueError::UserLimit(self.config.max_pending_per_user));
            }
            st.catch_up(&req.requester);
            let item = st.push(req, now);
            let position = self.position_of(st, item.id);
            Ok(Change::changed(Submitted { item, position }))
        })
    }

    /// Pops the best pending item and makes it active. `None` while paused or
    /// when nothing is pending. Several items may be active at once; the
    /// consumer decides when to call `next` again.
    pub fn next(&self) -> Option<QueueItem> {
        self.commit(|st, _| {
            if st.paused {
                return Ok(Change::none(None));
            }
            let Some(&index) = self.ordered(st).first() else {
                return Ok(Change::none(None));
            };
            st.items[index].state = ItemState::Active;
            let item = st.items[index].clone();
            let served = st.served_of(&item.requester) + 1;
            st.set_served(&item.requester, served);
            let event = custom("queue.item_activated", item_json(&item, None));
            Ok(Change::changed(Some(item)).with(event))
        })
        .unwrap_or(None)
    }

    /// Marks an active item done.
    pub fn complete(&self, id: ItemId) -> Result<QueueItem, QueueError> {
        self.finish(id, ItemState::Done, &[ItemState::Active])
    }

    /// Skips a pending or active item.
    pub fn skip(&self, id: ItemId) -> Result<QueueItem, QueueError> {
        self.finish(
            id,
            ItemState::Skipped,
            &[ItemState::Pending, ItemState::Active],
        )
    }

    /// Removes a pending or active item.
    pub fn remove(&self, id: ItemId) -> Result<QueueItem, QueueError> {
        self.finish(
            id,
            ItemState::Removed,
            &[ItemState::Pending, ItemState::Active],
        )
    }

    fn finish(
        &self,
        id: ItemId,
        to: ItemState,
        allowed_from: &[ItemState],
    ) -> Result<QueueItem, QueueError> {
        self.commit(|st, _| {
            let index = st.index_of(id)?;
            if !allowed_from.contains(&st.items[index].state) {
                return Err(QueueError::WrongState(id));
            }
            let item = st.finish(index, to, self.config.history_limit);
            Ok(Change::changed(item))
        })
    }

    /// Removes every pending item (active ones keep running). Returns how many.
    pub fn clear(&self) -> usize {
        self.commit(|st, _| {
            let mut count = 0;
            while let Some(index) = st.items.iter().position(|i| i.state == ItemState::Pending) {
                st.finish(index, ItemState::Removed, self.config.history_limit);
                count += 1;
            }
            Ok(if count > 0 {
                Change::changed(count)
            } else {
                Change::none(count)
            })
        })
        .unwrap_or(0)
    }

    /// Stops `next` from handing out items. Submitting still works.
    pub fn pause(&self) {
        self.set_paused(true);
    }

    pub fn resume(&self) {
        self.set_paused(false);
    }

    fn set_paused(&self, paused: bool) {
        let _ = self.commit(|st, _| {
            if st.paused == paused {
                return Ok(Change::none(()));
            }
            st.paused = paused;
            Ok(Change::changed(()))
        });
    }

    pub fn is_paused(&self) -> bool {
        self.state.lock().paused
    }

    /// Sets the moderator priority (higher goes first) of a pending item.
    pub fn set_priority(&self, id: ItemId, priority: i32) -> Result<(), QueueError> {
        self.commit(|st, _| {
            let index = st.index_of(id)?;
            if st.items[index].state != ItemState::Pending {
                return Err(QueueError::WrongState(id));
            }
            st.items[index].priority = priority;
            Ok(Change::changed(()))
        })
    }

    /// Moves a pending item to a 0-based `position` among pending items. The
    /// item's priority is adjusted only as far as needed to make it stay there,
    /// and all pending items get a manual slot, so fairness no longer reorders
    /// what was arranged by hand.
    pub fn move_item(&self, id: ItemId, position: usize) -> Result<(), QueueError> {
        self.commit(|st, _| {
            let index = st.index_of(id)?;
            if st.items[index].state != ItemState::Pending {
                return Err(QueueError::WrongState(id));
            }
            let mut order = self.ordered(st);
            order.retain(|&i| i != index);
            let at = position.min(order.len());
            let prev = at.checked_sub(1).map(|p| st.items[order[p]].priority);
            let next = order.get(at).map(|&i| st.items[i].priority);
            let lo = next.unwrap_or(i32::MIN);
            let hi = prev.unwrap_or(i32::MAX).max(lo);
            let moved = &mut st.items[index];
            moved.priority = moved.priority.clamp(lo, hi);
            order.insert(at, index);
            for (slot, &i) in order.iter().enumerate() {
                st.items[i].slot = Some(slot as u32);
            }
            Ok(Change::changed(()))
        })
    }

    /// Upvotes a pending item once per account; returns the new count.
    pub fn vote(&self, id: ItemId, voter: &AccountRef) -> Result<u32, QueueError> {
        self.commit(|st, _| {
            let index = st.index_of(id)?;
            let item = &mut st.items[index];
            if item.state != ItemState::Pending {
                return Err(QueueError::WrongState(id));
            }
            if item.voters.contains(voter) {
                return Ok(Change::none(item.votes));
            }
            item.voters.push(voter.clone());
            item.votes = item.voters.len() as u32;
            Ok(Change::changed(item.votes))
        })
    }

    // ----- queries -----

    /// Active items first, then pending items in the order `next` will take them.
    pub fn list(&self) -> Vec<QueueItem> {
        let st = self.state.lock();
        self.listing(&st).into_iter().map(|(i, _)| i).collect()
    }

    pub fn get(&self, id: ItemId) -> Option<QueueItem> {
        let st = self.state.lock();
        st.items
            .iter()
            .chain(&st.history)
            .find(|i| i.id == id)
            .cloned()
    }

    /// The first active item.
    pub fn current(&self) -> Option<QueueItem> {
        self.state
            .lock()
            .items
            .iter()
            .find(|i| i.state == ItemState::Active)
            .cloned()
    }

    /// Finished items, newest last.
    pub fn history(&self) -> Vec<QueueItem> {
        self.state.lock().history.clone()
    }

    // ----- voting mode -----

    /// Starts a vote. Needs 2 or more distinct options.
    pub fn start_vote(&self, options: Vec<String>, duration: Duration) -> Result<(), QueueError> {
        let mut clean: Vec<String> = Vec::new();
        for option in options {
            let option = option.trim().to_owned();
            if option.is_empty()
                || clean
                    .iter()
                    .any(|o| o.to_lowercase() == option.to_lowercase())
            {
                continue;
            }
            clean.push(option);
        }
        if clean.len() < 2 || clean.len() > self.config.max_vote_options {
            return Err(QueueError::BadVote(format!(
                "need 2 to {} distinct options",
                self.config.max_vote_options
            )));
        }
        if duration.is_zero() || duration.as_secs() > self.config.max_vote_seconds {
            return Err(QueueError::BadVote(format!(
                "duration must be 1 to {} seconds",
                self.config.max_vote_seconds
            )));
        }
        self.commit(|st, now| {
            if st.vote.is_some() {
                return Err(QueueError::VoteRunning);
            }
            let ends_at = now + chrono::Duration::from_std(duration).unwrap_or_default();
            st.vote = Some(VoteState {
                options: clean,
                started_at: now,
                ends_at,
                ballots: Vec::new(),
            });
            Ok(Change::changed(()))
        })
    }

    /// Records the account's ballot for the option named by `choice`: a
    /// 1-based number or the option text (case-insensitive). The latest ballot
    /// of an account wins. Returns the chosen option.
    pub fn cast_vote(&self, account: &AccountRef, choice: &str) -> Result<String, QueueError> {
        let choice = choice.trim();
        self.commit(|st, now| {
            let vote = st
                .vote
                .as_mut()
                .filter(|v| v.ends_at > now)
                .ok_or(QueueError::NoVote)?;
            let option = choice
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1))
                .filter(|&i| i < vote.options.len())
                .or_else(|| {
                    vote.options
                        .iter()
                        .position(|o| o.to_lowercase() == choice.to_lowercase())
                })
                .ok_or_else(|| QueueError::UnknownOption(choice.to_owned()))?;
            let ballot = Ballot {
                account: account.clone(),
                option,
                at: now,
            };
            match vote.ballots.iter_mut().find(|b| &b.account == account) {
                Some(existing) if existing.option == option => {
                    return Ok(Change::none(vote.options[option].clone()));
                }
                Some(existing) => *existing = ballot,
                None => vote.ballots.push(ballot),
            }
            Ok(Change::changed(vote.options[option].clone()))
        })
    }

    /// The running vote, if any.
    pub fn vote_status(&self) -> Option<VoteState> {
        self.state.lock().vote.clone()
    }

    /// Result of the most recent finished vote.
    pub fn last_vote(&self) -> Option<VoteResult> {
        self.state.lock().last_vote.clone()
    }

    /// Ends the running vote now.
    pub fn end_vote(&self) -> Result<VoteResult, QueueError> {
        self.commit(|st, now| {
            if st.vote.is_none() {
                return Err(QueueError::NoVote);
            }
            Ok(self.finish_vote(st, now))
        })
    }

    /// Ends the vote if its time is up. Called periodically by [`run`](Self::run).
    pub fn tick(&self) -> Option<VoteResult> {
        self.commit(|st, now| {
            if st.vote.as_ref().is_some_and(|v| v.ends_at <= now) {
                let Change {
                    value,
                    events,
                    changed,
                } = self.finish_vote(st, now);
                Ok(Change {
                    value: Some(value),
                    events,
                    changed,
                })
            } else {
                Ok(Change::none(None))
            }
        })
        .unwrap_or(None)
    }

    fn finish_vote(&self, st: &mut State, now: DateTime<Utc>) -> Change<VoteResult> {
        let result = st.close_vote(now).expect("a vote was running");
        let event = custom(
            "queue.vote_result",
            json!({
                "options": result.options,
                "tallies": result.tallies,
                "winner": result.winner,
                "winner_option": result.winner_option(),
                "total": result.total,
                "ended_at": result.ended_at,
            }),
        );
        if self.config.vote_enqueue_winner {
            if let Some(option) = result.winner_option() {
                let mut req = SubmitRequest::new(
                    AccountRef {
                        platform: PlatformId::new("queue"),
                        id: "vote".to_owned(),
                    },
                    "投票",
                    "vote",
                    option,
                );
                req.priority = self.config.vote_winner_priority;
                st.push(req, now);
            }
        }
        Change::changed(result).with(event)
    }

    // ----- persistence -----

    /// Writes the snapshot to the settings store (no-op without a store).
    pub async fn persist(&self) -> anyhow::Result<()> {
        let Some(store) = &self.store else {
            return Ok(());
        };
        let _guard = self.persist_lock.lock().await;
        self.dirty.store(false, Ordering::SeqCst);
        let snapshot = serde_json::to_value(&*self.state.lock())?;
        let result = store
            .set(&ProfileId::from(STATE_PROFILE), STATE_KEY, Some(snapshot))
            .await;
        if result.is_err() {
            self.dirty.store(true, Ordering::SeqCst);
        }
        result
    }

    /// Loads the snapshot from the settings store, if one exists. Returns
    /// whether state was restored.
    pub async fn restore(&self) -> anyhow::Result<bool> {
        let Some(store) = &self.store else {
            return Ok(false);
        };
        let Some(value) = store
            .get(&ProfileId::from(STATE_PROFILE), STATE_KEY)
            .await?
        else {
            return Ok(false);
        };
        let restored: State = serde_json::from_value(value)?;
        let event = {
            let mut st = self.state.lock();
            *st = restored;
            self.changed_event(&st)
        };
        self.emit(vec![event]);
        Ok(true)
    }

    /// Background loop: closes expired votes and writes debounced snapshots
    /// until `cancel` fires (then writes a final one if needed).
    pub async fn run(&self, cancel: CancellationToken) {
        let debounce = Duration::from_millis(self.config.persist_debounce_ms);
        let mut ticker = tokio::time::interval(Duration::from_millis(self.config.tick_ms.max(10)));
        let mut save_at: Option<Instant> = None;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    if self.dirty.load(Ordering::SeqCst) {
                        if let Err(e) = self.persist().await {
                            warn!(error = %e, "could not save the queue on shutdown");
                        }
                    }
                    return;
                }
                _ = self.wake.notified() => {
                    save_at.get_or_insert(Instant::now() + debounce);
                }
                _ = ticker.tick() => {
                    self.tick();
                }
            }
            if save_at.is_some_and(|t| Instant::now() >= t) {
                save_at = None;
                if let Err(e) = self.persist().await {
                    warn!(error = %e, "could not save the queue; retrying");
                    save_at = Some(Instant::now() + Duration::from_secs(5));
                }
            }
        }
    }

    // ----- internals -----

    /// Runs a mutation under the lock, then marks the state dirty and
    /// publishes `queue.changed` and the mutation's own events.
    fn commit<R>(
        &self,
        f: impl FnOnce(&mut State, DateTime<Utc>) -> Result<Change<R>, QueueError>,
    ) -> Result<R, QueueError> {
        let (value, events) = {
            let mut st = self.state.lock();
            let change = f(&mut st, (self.clock)())?;
            if !change.changed {
                return Ok(change.value);
            }
            let mut events = vec![self.changed_event(&st)];
            events.extend(change.events);
            (change.value, events)
        };
        self.dirty.store(true, Ordering::SeqCst);
        self.wake.notify_one();
        self.emit(events);
        Ok(value)
    }

    fn emit(&self, events: Vec<Event>) {
        if let Some(publisher) = &self.publisher {
            for event in events {
                publisher(event);
            }
        }
    }

    fn affinity(&self, account: &AccountRef) -> f32 {
        self.social
            .as_ref()
            .and_then(|s| s.attitude(account))
            .map_or(0.0, |a| a.affinity)
    }

    /// Indexes into `st.items` of the pending items, in service order.
    fn ordered(&self, st: &State) -> Vec<usize> {
        let mut by_user: HashMap<&AccountRef, Vec<usize>> = HashMap::new();
        for (index, item) in st.items.iter().enumerate() {
            if item.state == ItemState::Pending {
                by_user.entry(&item.requester).or_default().push(index);
            }
        }
        let min_served = by_user
            .keys()
            .map(|a| st.served_of(a))
            .min()
            .unwrap_or_default();
        let mut keyed = Vec::new();
        for (account, mut indexes) in by_user {
            indexes.sort_by_key(|&i| {
                let item = &st.items[i];
                (
                    Reverse(item.priority),
                    item.slot.unwrap_or(u32::MAX),
                    item.created_at,
                    item.id,
                )
            });
            let base = st.served_of(account) - min_served;
            let affinity = self.affinity(account);
            for (place, index) in indexes.into_iter().enumerate() {
                let item = &st.items[index];
                let weight = (affinity / 10.0 * self.config.affinity_weight
                    + item.votes as f32 * self.config.vote_weight)
                    .round() as i64;
                keyed.push((
                    Reverse(item.priority),
                    item.slot.unwrap_or(u32::MAX),
                    base + place as u64,
                    Reverse(weight),
                    item.created_at,
                    item.id,
                    index,
                ));
            }
        }
        keyed.sort();
        keyed.into_iter().map(|k| k.6).collect()
    }

    fn position_of(&self, st: &State, id: ItemId) -> usize {
        self.ordered(st)
            .iter()
            .position(|&i| st.items[i].id == id)
            .map_or(0, |p| p + 1)
    }

    /// Active items, then pending items with their 1-based place.
    fn listing(&self, st: &State) -> Vec<(QueueItem, Option<usize>)> {
        let mut out: Vec<_> = st
            .items
            .iter()
            .filter(|i| i.state == ItemState::Active)
            .map(|i| (i.clone(), None))
            .collect();
        out.extend(
            self.ordered(st)
                .into_iter()
                .enumerate()
                .map(|(place, i)| (st.items[i].clone(), Some(place + 1))),
        );
        out
    }

    fn changed_event(&self, st: &State) -> Event {
        let items: Vec<Value> = self
            .listing(st)
            .iter()
            .map(|(item, place)| item_json(item, *place))
            .collect();
        let mut payload = json!({ "items": items, "paused": st.paused });
        if let Some(vote) = &st.vote {
            payload["vote"] = json!({
                "options": vote.options,
                "tallies": vote.tallies(),
                "total": vote.ballots.len(),
                "started_at": vote.started_at,
                "ends_at": vote.ends_at,
            });
        }
        custom("queue.changed", payload)
    }
}

fn custom(topic: &str, payload: Value) -> Event {
    Event::Custom {
        topic: topic.to_owned(),
        payload,
    }
}

/// Item as shown to overlays and consumers (voter list left out).
fn item_json(item: &QueueItem, position: Option<usize>) -> Value {
    json!({
        "id": item.id,
        "requester": item.requester,
        "requester_name": item.requester_name,
        "kind": item.kind,
        "text": item.text,
        "context": item.context,
        "created_at": item.created_at,
        "priority": item.priority,
        "votes": item.votes,
        "state": item.state,
        "position": position,
    })
}
