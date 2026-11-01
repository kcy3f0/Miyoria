//! `memory show | forget | export`, registered in the command registry when
//! the `commands` module is running.
//!
//! Everyone may manage their own memories (`memory.self.*`); the optional
//! `user` argument (someone else) needs `memory.admin.*`.

use std::sync::Arc;

use chrono::Utc;
use miyoria_commands::{
    ArgKind, ArgSpec, CommandRegistry, CommandReply, CommandSpec, Invocation, Permissions, Role,
};
use miyoria_store::{MemoryKind, MemoryRecord};
use miyoria_types::{AccountRef, Authorizer, PersonId, Subject};
use parking_lot::Mutex;
use serde_json::json;
use tracing::warn;

use crate::engine::MemoryEngine;
use crate::scope::{scope_label, visible_scopes};
use crate::score::relative_date;

pub const PATHS: [&str; 3] = ["memory show", "memory forget", "memory export"];
/// Replies stay below Discord's 2000-character message limit.
const MAX_REPLY_CHARS: usize = 1900;

/// Looks up the current `dyn Authorizer` service, if any.
pub type AuthorizerLookup = Arc<dyn Fn() -> Option<Arc<dyn Authorizer>> + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
    Show,
    Forget,
    Export,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Self::Show => "show",
            Self::Forget => "forget",
            Self::Export => "export",
        }
    }
}

#[derive(Clone)]
struct Handler {
    engine: Arc<MemoryEngine>,
    perms: Permissions,
    authorizer: AuthorizerLookup,
}

/// Remembers which registry the commands went into, so they can be removed
/// on stop and re-registered when the `commands` module restarts.
#[derive(Default)]
pub struct MemoryCommands {
    installed: Mutex<Option<Arc<CommandRegistry>>>,
}

impl MemoryCommands {
    /// Registers the commands in `registry` unless already there.
    pub fn install(
        &self,
        registry: Arc<CommandRegistry>,
        engine: Arc<MemoryEngine>,
        authorizer: AuthorizerLookup,
    ) {
        let mut installed = self.installed.lock();
        if installed
            .as_ref()
            .is_some_and(|r| Arc::ptr_eq(r, &registry))
        {
            return;
        }
        if let Some(old) = installed.take() {
            unregister(&old);
        }
        let handler = Handler {
            engine,
            perms: registry.permissions().clone(),
            authorizer,
        };
        match register(&registry, handler) {
            Ok(()) => *installed = Some(registry),
            Err(e) => {
                warn!(error = %format!("{e:#}"), "could not register memory commands");
                unregister(&registry);
            }
        }
    }

    pub fn uninstall(&self) {
        if let Some(registry) = self.installed.lock().take() {
            unregister(&registry);
        }
    }
}

fn unregister(registry: &CommandRegistry) {
    for path in PATHS {
        registry.unregister(path);
    }
}

fn user_arg() -> ArgSpec {
    ArgSpec::new("user", "(管理員)要查看的其他人", ArgKind::User).optional()
}

fn register(registry: &CommandRegistry, handler: Handler) -> anyhow::Result<()> {
    registry.set_group_description("memory", "我記得的關於你的事");
    let specs = [
        (
            Op::Show,
            CommandSpec::new("memory show", "看看我記得關於你的哪些事(只有你看得到)")
                .arg(user_arg()),
        ),
        (
            Op::Forget,
            CommandSpec::new("memory forget", "讓我忘掉關於你的事")
                .arg(ArgSpec::new(
                    "target",
                    "要忘掉的關鍵字,或 all 忘掉全部",
                    ArgKind::String,
                ))
                .arg(user_arg()),
        ),
        (
            Op::Export,
            CommandSpec::new("memory export", "匯出我記得的關於你的事(JSON)").arg(user_arg()),
        ),
    ];
    for (op, spec) in specs {
        let h = handler.clone();
        let spec = spec
            .permission(format!("memory.self.{}", op.name()))
            .ephemeral(true);
        registry.register(spec, move |inv: Invocation| {
            let h = h.clone();
            async move { h.run(op, inv).await }
        })?;
    }
    Ok(())
}

impl Handler {
    async fn run(&self, op: Op, inv: Invocation) -> anyhow::Result<CommandReply> {
        let other = inv.account("user").filter(|a| a != &inv.invoker);
        if other.is_some() && !self.admin_allowed(&inv, &format!("memory.admin.{}", op.name())) {
            return Ok(CommandReply::ephemeral(
                "別人的記憶不能隨便看啦,這要管理員才行。",
            ));
        }
        let target = other.clone().unwrap_or_else(|| inv.invoker.clone());
        let person = self.engine.person_of(&target).await;
        let who = if other.is_some() {
            format!("{} ", target.id)
        } else {
            "你".to_owned()
        };
        let text = match op {
            Op::Show => self.show(&inv, &target, person, &who).await?,
            Op::Export => self.export(&inv, &target, person, &who).await?,
            Op::Forget => {
                let raw = inv.str("target").unwrap_or_default().trim().to_owned();
                self.forget(&target, person, &raw, &who).await?
            }
        };
        Ok(CommandReply::ephemeral(text))
    }

    /// `memory.admin.*` check. A node the authorizer grants to an unknown
    /// account is no real gate (the phase-1 role scheme opens every node
    /// outside `admin.` / `owner.`), so then guild admins and owners decide.
    fn admin_allowed(&self, inv: &Invocation, node: &str) -> bool {
        if let Some(auth) = (self.authorizer)() {
            let nobody = Subject::account(AccountRef {
                platform: inv.invoker.platform.clone(),
                id: "\u{0}nobody".to_owned(),
            });
            if !auth.allows_subject(&nobody, node) {
                return auth.allows_subject(&inv.subject(), node);
            }
        }
        self.perms.role_of(inv) >= Role::Admin
    }

    /// Records about `target` that may be shown in the invocation's context.
    async fn visible(
        &self,
        inv: &Invocation,
        target: &AccountRef,
        person: Option<PersonId>,
    ) -> anyhow::Result<Vec<MemoryRecord>> {
        // Only the invoker is "in" the context of the reply, so DM memories
        // show up only in the invoker's own DM.
        let scopes = visible_scopes(&inv.context, [&inv.invoker], person);
        Ok(self
            .engine
            .memories_of(person, target, false)
            .await?
            .into_iter()
            .filter(|r| scopes.contains(&r.scope))
            .collect())
    }

    async fn show(
        &self,
        inv: &Invocation,
        target: &AccountRef,
        person: Option<PersonId>,
        who: &str,
    ) -> anyhow::Result<String> {
        let records = self.visible(inv, target, person).await?;
        if records.is_empty() {
            return Ok(format!("在這裡,我好像還沒記得關於{who}的什麼事……"));
        }
        let now = Utc::now();
        let mut out = format!("我記得關於{who}的事:\n");
        for (i, r) in records.iter().enumerate() {
            let line = format!(
                "- 〔{}〕{}({})\n",
                kind_label(r.kind),
                r.content.replace('\n', " "),
                relative_date(r.created_at, now)
            );
            if out.chars().count() + line.chars().count() > MAX_REPLY_CHARS - 40 {
                out.push_str(&format!("……還有 {} 件沒列出來。", records.len() - i));
                break;
            }
            out.push_str(&line);
        }
        Ok(out.trim_end().to_owned())
    }

    async fn export(
        &self,
        inv: &Invocation,
        target: &AccountRef,
        person: Option<PersonId>,
        who: &str,
    ) -> anyhow::Result<String> {
        let records = self.visible(inv, target, person).await?;
        if records.is_empty() {
            return Ok(format!("在這裡沒有關於{who}的記憶可以匯出。"));
        }
        let mut items: Vec<serde_json::Value> = Vec::new();
        let mut truncated = 0;
        for (i, r) in records.iter().enumerate() {
            items.push(export_item(r));
            let size = serde_json::to_string_pretty(&items).map_or(0, |s| s.chars().count());
            if size > MAX_REPLY_CHARS - 80 {
                items.pop();
                truncated = records.len() - i;
                break;
            }
        }
        let body = serde_json::to_string_pretty(&items)?;
        let mut out = format!("```json\n{body}\n```");
        if truncated > 0 {
            out.push_str(&format!("\n(太長了,還有 {truncated} 筆沒放進來。)"));
        }
        Ok(out)
    }

    async fn forget(
        &self,
        target: &AccountRef,
        person: Option<PersonId>,
        raw: &str,
        who: &str,
    ) -> anyhow::Result<String> {
        if raw.is_empty() {
            return Ok("要忘掉什麼?給我一個關鍵字,或是 all。".to_owned());
        }
        if raw.eq_ignore_ascii_case("all") {
            let n = self.engine.forget(person, target, None).await?;
            return Ok(if n == 0 {
                format!("我本來就沒記得關於{who}的事。")
            } else {
                format!("……好啦,關於{who}的事我全部忘掉了({n} 件)。")
            });
        }
        let n = self.engine.forget(person, target, Some(raw)).await?;
        Ok(if n == 0 {
            format!("我不記得關於{who}跟「{raw}」有關的事耶。")
        } else {
            format!("好,關於{who}跟「{raw}」有關的 {n} 件事,我忘掉了。")
        })
    }
}

fn export_item(r: &MemoryRecord) -> serde_json::Value {
    json!({
        "kind": r.kind,
        "content": r.content,
        "importance": (r.importance * 100.0).round() / 100.0,
        "confidence": (r.confidence * 100.0).round() / 100.0,
        "scope": scope_label(&r.scope),
        "created_at": r.created_at.to_rfc3339(),
        "due": r.due.map(|d| d.to_rfc3339()),
    })
}

fn kind_label(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Episode => "經歷",
        MemoryKind::Fact => "事實",
        MemoryKind::SelfNote => "我的筆記",
        MemoryKind::Followup => "之後要問",
    }
}
