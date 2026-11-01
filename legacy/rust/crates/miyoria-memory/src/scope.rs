//! Privacy scopes: where a memory may be recalled, and where new memories go.
//!
//! Visible in a context:
//! * `Global` everywhere;
//! * `Guild` of the context's guild;
//! * `Channel` of exactly this context;
//! * `Dm { account }` only inside a DM, for the accounts in it;
//! * `Person` of people present (with a known [`PersonId`]).
//!
//! Anything learned in a DM is scoped to that DM, so it never surfaces
//! elsewhere (unless `allow_global_from_dm` is set for person-wide facts).

use miyoria_store::{MemoryKind, MemoryScope};
use miyoria_types::{AccountRef, ContextKey, ContextKind, PersonId, PromptRequest};

use crate::config::{GuildScope, MemoryConfig};

/// Scopes whose memories may be recalled in `context` with these accounts
/// and people present.
pub fn visible_scopes<'a>(
    context: &ContextKey,
    accounts: impl IntoIterator<Item = &'a AccountRef>,
    persons: impl IntoIterator<Item = PersonId>,
) -> Vec<MemoryScope> {
    let mut scopes = vec![MemoryScope::Global];
    if let Some(guild) = &context.scope {
        scopes.push(MemoryScope::Guild {
            platform: context.platform.clone(),
            guild: guild.clone(),
        });
    }
    scopes.push(MemoryScope::Channel {
        context: context.clone(),
    });
    if is_private(context) {
        for account in accounts {
            push_unique(
                &mut scopes,
                MemoryScope::Dm {
                    account: account.clone(),
                },
            );
        }
    }
    for person in persons {
        push_unique(&mut scopes, MemoryScope::Person { person });
    }
    scopes
}

/// [`visible_scopes`] for a prompt request (participants and speakers).
pub fn request_scopes(request: &PromptRequest) -> Vec<MemoryScope> {
    let accounts = request
        .participants
        .iter()
        .map(|p| &p.account)
        .chain(&request.speakers);
    visible_scopes(&request.context, accounts, present_people(request))
}

/// People present in a prompt request.
pub fn present_people(request: &PromptRequest) -> Vec<PersonId> {
    let mut out = Vec::new();
    for p in request.participants.iter().filter_map(|p| p.person) {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// A DM, or a context outside any guild.
pub fn is_private(context: &ContextKey) -> bool {
    context.kind == ContextKind::Dm || context.scope.is_none()
}

/// Scope of a new memory learned in `context`.
///
/// * DM (or guild-less context): `Dm { partner }`, or `Channel` when the
///   partner is unknown or there are several. With `allow_global_from_dm`,
///   global facts about a known person become `Person`.
/// * Guild: self notes → `Global`; global facts about a known person →
///   `Person`; everything else → `Guild` (or `Channel`, per `guild_scope`).
pub fn scope_for_new(
    config: &MemoryConfig,
    context: &ContextKey,
    dm_partner: Option<&AccountRef>,
    kind: MemoryKind,
    global_person: Option<PersonId>,
) -> MemoryScope {
    if is_private(context) {
        if kind == MemoryKind::Fact
            && config.allow_global_from_dm
            && let Some(person) = global_person
        {
            return MemoryScope::Person { person };
        }
        return match dm_partner {
            Some(account) if context.kind == ContextKind::Dm => MemoryScope::Dm {
                account: account.clone(),
            },
            _ => MemoryScope::Channel {
                context: context.clone(),
            },
        };
    }
    match (kind, global_person) {
        (MemoryKind::SelfNote, _) => MemoryScope::Global,
        (MemoryKind::Fact, Some(person)) => MemoryScope::Person { person },
        _ => match (config.guild_scope, &context.scope) {
            (GuildScope::Guild, Some(guild)) => MemoryScope::Guild {
                platform: context.platform.clone(),
                guild: guild.clone(),
            },
            _ => MemoryScope::Channel {
                context: context.clone(),
            },
        },
    }
}

/// Short label for exports and admin views.
pub fn scope_label(scope: &MemoryScope) -> String {
    match scope {
        MemoryScope::Global => "global".to_owned(),
        MemoryScope::Guild { guild, .. } => format!("guild:{guild}"),
        MemoryScope::Channel { context } => format!("channel:{context}"),
        MemoryScope::Dm { .. } => "dm".to_owned(),
        MemoryScope::Person { .. } => "person".to_owned(),
    }
}

fn push_unique(scopes: &mut Vec<MemoryScope>, scope: MemoryScope) {
    if !scopes.contains(&scope) {
        scopes.push(scope);
    }
}
