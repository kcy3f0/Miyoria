//! `/api/people*`: people the active profile knows and how she feels about
//! them. Reads come from the stores (with the social engine's cached numbers
//! when it runs); every change goes through the social engine.

use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use miyoria_memory::MemoryEngine;
use miyoria_social::Social;
use miyoria_social::social::{BLOCKED_TAG, attitude};
use miyoria_store::{
    IdentityStore, MemoryFilter, MemoryRecordStore, PeopleStore, Person, Relationship,
    RelationshipDelta, RelationshipStore,
};
use miyoria_types::{PersonId, ProfileId};
use serde::Deserialize;
use ulid::Ulid;

use crate::server::{ApiError, ApiResult, ApiState, body, query};
use crate::session::actor;
use crate::types::{AdjustPersonRequest, Page, PersonDetail, PersonSummary, UpdatePersonRequest};

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 500;
const MAX_HISTORY: usize = 500;
const MAX_TAGS: usize = 32;
const MAX_TAG_CHARS: usize = 32;
const MAX_NOTES_CHARS: usize = 2000;
const MAX_CALL_NAME_CHARS: usize = 64;

pub(crate) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/people", get(list))
        .route("/api/people/{id}", get(detail).patch(update))
        .route("/api/people/{id}/adjust", post(adjust))
}

fn internal(e: anyhow::Error) -> ApiError {
    ApiError::internal(&e)
}

/// The services people routes read from.
struct Ctx {
    profile: ProfileId,
    relationships: Arc<dyn RelationshipStore>,
    identity: Arc<dyn IdentityStore>,
    people: Option<Arc<dyn PeopleStore>>,
    social: Option<Arc<Social>>,
}

impl Ctx {
    fn new(state: &ApiState) -> Result<Self, ApiError> {
        let social = state.optional::<Social>();
        let profile = match &social {
            Some(s) => s.profile().clone(),
            None => state.profile()?,
        };
        Ok(Self {
            profile,
            relationships: state.service::<dyn RelationshipStore>("relationship store")?,
            identity: state.service::<dyn IdentityStore>("identity store")?,
            people: state.optional::<dyn PeopleStore>(),
            social,
        })
    }

    /// The social engine's cached relationship, else the stored one.
    async fn relationship(&self, person: PersonId) -> Result<Option<Relationship>, ApiError> {
        if let Some(r) = self.social.as_ref().and_then(|s| s.relationship(person)) {
            return Ok(Some(r));
        }
        self.relationships
            .get(&self.profile, person)
            .await
            .map_err(internal)
    }

    /// The person with their accounts; `None` when nobody has this id.
    async fn person(&self, id: PersonId) -> Result<Option<Person>, ApiError> {
        let accounts = self.identity.accounts_of(id).await.map_err(internal)?;
        let Some(first) = accounts.first() else {
            return Ok(None);
        };
        if let Some(people) = &self.people
            && let Some(person) = people
                .person_by_account(&first.account)
                .await
                .map_err(internal)?
            && person.id == id
        {
            return Ok(Some(person));
        }
        Ok(Some(Person {
            id,
            display_name: first.display_name.clone(),
            created_at: accounts
                .iter()
                .map(|a| a.first_seen)
                .min()
                .unwrap_or(first.first_seen),
            accounts,
        }))
    }

    async fn summary(
        &self,
        id: PersonId,
        relationship: Option<Relationship>,
    ) -> Result<Option<PersonSummary>, ApiError> {
        let Some(person) = self.person(id).await? else {
            return Ok(None);
        };
        Ok(Some(summarize(person, relationship)))
    }

    async fn require_summary(&self, id: PersonId) -> Result<PersonSummary, ApiError> {
        let relationship = self.relationship(id).await?;
        self.summary(id, relationship)
            .await?
            .ok_or_else(|| unknown_person(&id.to_string()))
    }
}

fn summarize(person: Person, relationship: Option<Relationship>) -> PersonSummary {
    let attitude = relationship.as_ref().map(attitude);
    PersonSummary {
        person,
        label: attitude.as_ref().map(|a| a.label.clone()),
        blocked: attitude.is_some_and(|a| a.blocked),
        relationship,
    }
}

fn unknown_person(id: &str) -> ApiError {
    ApiError::not_found(format!("unknown person `{id}`"))
}

fn parse_person(id: &str) -> Result<PersonId, ApiError> {
    id.parse::<Ulid>()
        .map(PersonId)
        .map_err(|_| unknown_person(id))
}

#[derive(Deserialize)]
struct ListQuery {
    q: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
}

fn matches(summary: &PersonSummary, needle: &str) -> bool {
    let has = |s: &str| s.to_lowercase().contains(needle);
    has(&summary.person.display_name)
        || summary.person.id.to_string().to_lowercase() == needle
        || summary
            .person
            .accounts
            .iter()
            .any(|a| has(&a.display_name) || has(&a.account.id))
        || summary
            .relationship
            .as_ref()
            .and_then(|r| r.call_name.as_deref())
            .is_some_and(has)
}

/// `GET /api/people?q=&limit=&cursor=`: people with a relationship to the
/// active profile, most recent interaction first.
async fn list(
    State(state): State<ApiState>,
    q: Result<Query<ListQuery>, QueryRejection>,
) -> ApiResult<Page<PersonSummary>> {
    let q = query(q)?;
    let ctx = Ctx::new(&state)?;
    let offset = match q.cursor.as_deref().map(str::trim) {
        None | Some("") => 0,
        Some(c) => c
            .parse::<usize>()
            .map_err(|_| ApiError::bad_request(format!("invalid cursor `{c}`")))?,
    };
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let needle =
        q.q.as_deref()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());

    let mut rels = ctx
        .relationships
        .list(&ctx.profile)
        .await
        .map_err(internal)?;
    if let Some(social) = &ctx.social {
        for r in &mut rels {
            if let Some(cached) = social.relationship(r.person) {
                *r = cached;
            }
        }
    }
    rels.sort_by(|a, b| {
        b.last_interaction
            .cmp(&a.last_interaction)
            .then(b.updated_at.cmp(&a.updated_at))
    });
    let mut items = Vec::new();
    for r in rels {
        if let Some(summary) = ctx.summary(r.person, Some(r)).await?
            && needle.as_deref().is_none_or(|n| matches(&summary, n))
        {
            items.push(summary);
        }
    }
    let next_cursor = (items.len() > offset + limit).then(|| (offset + limit).to_string());
    let items = items.into_iter().skip(offset).take(limit).collect();
    Ok(Json(Page { items, next_cursor }))
}

/// Turns stored deltas (oldest first) into the absolute levels after each
/// one, walking back from the current values.
fn absolute_history(
    deltas: Vec<RelationshipDelta>,
    current: Option<&Relationship>,
) -> Vec<RelationshipDelta> {
    let (mut a, mut t, mut f) =
        current.map_or((0.0, 0.0, 0.0), |r| (r.affinity, r.trust, r.familiarity));
    let mut out: Vec<RelationshipDelta> = deltas
        .into_iter()
        .rev()
        .map(|d| {
            let level = RelationshipDelta {
                at: d.at,
                affinity: a,
                trust: t,
                familiarity: f,
                reason: d.reason,
            };
            a -= d.affinity;
            t -= d.trust;
            f -= d.familiarity;
            level
        })
        .collect();
    out.reverse();
    out
}

async fn memory_count(state: &ApiState, profile: &ProfileId, person: PersonId) -> u64 {
    let records = match state.optional::<MemoryEngine>() {
        Some(engine) => Some(engine.records().clone()),
        None => state.optional::<dyn MemoryRecordStore>(),
    };
    let Some(records) = records else {
        return 0;
    };
    let filter = MemoryFilter {
        subject: Some(person),
        limit: 100_000,
        ..Default::default()
    };
    records
        .list(profile, &filter)
        .await
        .map_or(0, |r| r.len() as u64)
}

/// `GET /api/people/{id}`.
async fn detail(State(state): State<ApiState>, Path(id): Path<String>) -> ApiResult<PersonDetail> {
    let person = parse_person(&id)?;
    let ctx = Ctx::new(&state)?;
    let summary = ctx.require_summary(person).await?;
    let mut deltas = ctx
        .relationships
        .deltas_since(&ctx.profile, person, DateTime::<Utc>::UNIX_EPOCH)
        .await
        .map_err(internal)?;
    if deltas.len() > MAX_HISTORY {
        deltas.drain(..deltas.len() - MAX_HISTORY);
    }
    let history = absolute_history(deltas, summary.relationship.as_ref());
    let memory_count = memory_count(&state, &ctx.profile, person).await;
    Ok(Json(PersonDetail {
        summary,
        history,
        memory_count,
    }))
}

fn clean_tags(tags: &[String]) -> Result<Vec<String>, ApiError> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() || tag == BLOCKED_TAG {
            continue;
        }
        if tag.chars().count() > MAX_TAG_CHARS {
            return Err(ApiError::bad_request(format!(
                "tag `{tag}` is longer than {MAX_TAG_CHARS} characters"
            )));
        }
        if !out.iter().any(|t| t == tag) {
            out.push(tag.to_owned());
        }
    }
    if out.len() > MAX_TAGS {
        return Err(ApiError::bad_request(format!(
            "at most {MAX_TAGS} tags are allowed"
        )));
    }
    Ok(out)
}

fn validate(request: &UpdatePersonRequest) -> Result<(), ApiError> {
    if let Some(notes) = &request.notes
        && notes.chars().count() > MAX_NOTES_CHARS
    {
        return Err(ApiError::bad_request(format!(
            "notes are longer than {MAX_NOTES_CHARS} characters"
        )));
    }
    if let Some(Some(name)) = &request.call_name
        && name.trim().chars().count() > MAX_CALL_NAME_CHARS
    {
        return Err(ApiError::bad_request(format!(
            "call_name is longer than {MAX_CALL_NAME_CHARS} characters"
        )));
    }
    Ok(())
}

/// Tags to add and remove so the non-`blocked` tags become `wanted`.
fn tag_changes(current: &[String], wanted: &[String]) -> (Vec<String>, Vec<String>) {
    let add = wanted
        .iter()
        .filter(|t| !current.contains(t))
        .cloned()
        .collect();
    let remove = current
        .iter()
        .filter(|t| *t != BLOCKED_TAG && !wanted.contains(t))
        .cloned()
        .collect();
    (add, remove)
}

async fn apply_update(
    ctx: &Ctx,
    social: &Social,
    person: PersonId,
    request: &UpdatePersonRequest,
    tags: Option<(Vec<String>, Vec<String>)>,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    if let Some((add, remove)) = tags {
        for tag in &remove {
            social.set_tag(person, tag, false, &actor(), now).await?;
        }
        for tag in &add {
            social.set_tag(person, tag, true, &actor(), now).await?;
        }
    }
    if let Some(blocked) = request.blocked {
        social
            .set_tag(person, BLOCKED_TAG, blocked, &actor(), now)
            .await?;
    }
    if let Some(call_name) = &request.call_name {
        let call_name = call_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        social.set_call_name(person, call_name, now).await?;
    }
    if let Some(notes) = &request.notes {
        // The engine has no notes setter: write the stored row and reload
        // its cache (after flushing its pending counters).
        social.flush().await?;
        let mut rel = match ctx.relationships.get(&ctx.profile, person).await? {
            Some(r) => r,
            None => social.adjust(person, 0.0, &actor(), now).await?,
        };
        rel.notes = notes.trim().to_owned();
        rel.updated_at = now;
        ctx.relationships.upsert(&rel).await?;
        social.load().await?;
    }
    Ok(())
}

/// `PATCH /api/people/{id}`.
async fn update(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    request: Result<Json<UpdatePersonRequest>, JsonRejection>,
) -> ApiResult<PersonSummary> {
    let request = body(request)?;
    let person = parse_person(&id)?;
    validate(&request)?;
    let wanted = request.tags.as_deref().map(clean_tags).transpose()?;
    let social = state.service::<Social>("social module")?;
    let ctx = Ctx::new(&state)?;
    if ctx.person(person).await?.is_none() {
        return Err(unknown_person(&id));
    }
    let tags = match wanted {
        Some(wanted) => {
            let current = ctx
                .relationship(person)
                .await?
                .map(|r| r.tags)
                .unwrap_or_default();
            Some(tag_changes(&current, &wanted))
        }
        None => None,
    };
    let result = apply_update(&ctx, &social, person, &request, tags, Utc::now()).await;
    let mut detail = serde_json::to_value(&request).unwrap_or_default();
    if let Err(e) = &result {
        detail["error"] = format!("{e:#}").into();
    }
    state
        .audit("person.update", &person.to_string(), detail, result.is_ok())
        .await;
    result.map_err(internal)?;
    Ok(Json(ctx.require_summary(person).await?))
}

/// `POST /api/people/{id}/adjust`: adds to the affinity, ignoring caps.
async fn adjust(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    request: Result<Json<AdjustPersonRequest>, JsonRejection>,
) -> ApiResult<PersonSummary> {
    let request = body(request)?;
    let person = parse_person(&id)?;
    if !request.affinity.is_finite() || request.affinity.abs() > 200.0 {
        return Err(ApiError::bad_request(
            "`affinity` must be a number between -200 and 200",
        ));
    }
    let social = state.service::<Social>("social module")?;
    let ctx = Ctx::new(&state)?;
    if ctx.person(person).await?.is_none() {
        return Err(unknown_person(&id));
    }
    let result = social
        .adjust(person, request.affinity, &actor(), Utc::now())
        .await;
    let detail = serde_json::json!({ "affinity": request.affinity });
    state
        .audit("person.adjust", &person.to_string(), detail, result.is_ok())
        .await;
    result.map_err(internal)?;
    Ok(Json(ctx.require_summary(person).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(affinity: f32, reason: &str) -> RelationshipDelta {
        RelationshipDelta {
            at: Utc::now(),
            affinity,
            trust: 0.0,
            familiarity: 1.0,
            reason: reason.to_owned(),
        }
    }

    #[test]
    fn history_is_absolute_and_oldest_first() {
        let current = Relationship {
            profile: ProfileId::from("p"),
            person: PersonId::new(),
            affinity: 15.0,
            trust: 50.0,
            familiarity: 2.0,
            tags: Vec::new(),
            notes: String::new(),
            call_name: None,
            interactions: 2,
            last_interaction: None,
            updated_at: Utc::now(),
        };
        let history = absolute_history(vec![delta(10.0, "a"), delta(5.0, "b")], Some(&current));
        let levels: Vec<(f32, f32, &str)> = history
            .iter()
            .map(|d| (d.affinity, d.familiarity, d.reason.as_str()))
            .collect();
        assert_eq!(levels, [(10.0, 1.0, "a"), (15.0, 2.0, "b")]);
    }
}
