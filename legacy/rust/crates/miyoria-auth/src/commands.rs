//! `admin role ...` and `admin perm ...` commands.
//!
//! Besides the command's permission node, every change is limited by rank:
//! the invoker may only hand out, take away, map or override roles ranked
//! strictly below their own effective role, and may not change someone who
//! ranks as high or higher. Global changes are judged by the invoker's
//! global role, so a guild admin cannot grant roles in other guilds. Config
//! owners may do everything.

use std::future::Future;
use std::sync::Arc;

use miyoria_commands::{ArgKind, ArgSpec, CommandRegistry, CommandReply, CommandSpec, Invocation};
use miyoria_kernel::ServiceRegistry;
use miyoria_store::{AuthScope, NodeOverride, RoleDefinition, RoleMapping};
use miyoria_types::{AccountRef, Subject};
use parking_lot::Mutex;
use tracing::{debug, warn};

use crate::node::is_valid_pattern;
use crate::resolve::{Resolution, Source, scope_covers};
use crate::service::{AuthService, account_str};

pub(crate) const PATHS: [&str; 9] = [
    "admin role list",
    "admin role assign",
    "admin role revoke",
    "admin role map",
    "admin role unmap",
    "admin role whois",
    "admin perm allow",
    "admin perm deny",
    "admin perm clear",
];

const NODE_LIST: &str = "admin.role.list";
const NODE_ASSIGN: &str = "admin.role.assign";
const NODE_MAP: &str = "admin.role.map";
const NODE_WHOIS: &str = "admin.role.whois";
const NODE_PERM: &str = "admin.perm.set";
const SHOWN_NODES: usize = 6;

/// Remembers which registry the commands went into, so they can be removed
/// on stop and re-registered when the `commands` module restarts.
#[derive(Default)]
pub(crate) struct AuthCommands {
    installed: Mutex<Option<Arc<CommandRegistry>>>,
}

impl AuthCommands {
    /// Registers the commands in the current `CommandRegistry` service, if
    /// any and not done already.
    pub fn install(&self, services: &ServiceRegistry, service: &Arc<AuthService>) {
        let Some(registry) = services.get::<CommandRegistry>() else {
            debug!("no command registry, auth commands not registered");
            return;
        };
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
        match register(&registry, service) {
            Ok(()) => *installed = Some(registry),
            Err(e) => {
                warn!(error = %format!("{e:#}"), "could not register auth commands");
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

fn add<F, Fut>(
    registry: &CommandRegistry,
    service: &Arc<AuthService>,
    spec: CommandSpec,
    handler: F,
) -> anyhow::Result<()>
where
    F: Fn(Arc<AuthService>, Invocation) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = CommandReply> + Send + 'static,
{
    let service = service.clone();
    registry.register(spec.ephemeral(true), move |inv| {
        let reply = handler(service.clone(), inv);
        async move { Ok(reply.await) }
    })
}

fn scope_arg() -> ArgSpec {
    ArgSpec::new(
        "scope",
        "範圍(預設:在伺服器裡是 guild,私訊裡是 global)",
        ArgKind::Choice(vec!["global".into(), "guild".into(), "channel".into()]),
    )
    .optional()
}

fn user_arg(description: &str) -> ArgSpec {
    ArgSpec::new("user", description, ArgKind::User)
}

fn role_arg() -> ArgSpec {
    ArgSpec::new("role", "Miyoria 角色,例如 moderator", ArgKind::String)
}

fn register(registry: &CommandRegistry, service: &Arc<AuthService>) -> anyhow::Result<()> {
    registry.set_group_description("admin role", "角色管理");
    registry.set_group_description("admin perm", "權限節點覆寫");
    add(
        registry,
        service,
        CommandSpec::new("admin role list", "列出角色、身分組對應與覆寫").permission(NODE_LIST),
        list,
    )?;
    for revoke in [false, true] {
        let (path, description) = if revoke {
            ("admin role revoke", "收回某人的角色")
        } else {
            ("admin role assign", "指派角色給某人")
        };
        let spec = CommandSpec::new(path, description)
            .arg(user_arg("對象"))
            .arg(role_arg())
            .arg(scope_arg())
            .permission(NODE_ASSIGN);
        add(registry, service, spec, move |svc, inv| {
            assign(svc, inv, revoke)
        })?;
    }
    add(
        registry,
        service,
        CommandSpec::new("admin role map", "把 Discord 身分組對應到 Miyoria 角色")
            .arg(ArgSpec::new(
                "discord_role",
                "Discord 身分組",
                ArgKind::Role,
            ))
            .arg(role_arg())
            .permission(NODE_MAP),
        map,
    )?;
    add(
        registry,
        service,
        CommandSpec::new("admin role unmap", "取消 Discord 身分組的對應")
            .arg(ArgSpec::new(
                "discord_role",
                "Discord 身分組",
                ArgKind::Role,
            ))
            .permission(NODE_MAP),
        unmap,
    )?;
    add(
        registry,
        service,
        CommandSpec::new("admin role whois", "查某人在這裡實際的角色和原因")
            .arg(user_arg("對象(預設是你自己)").optional())
            .permission(NODE_WHOIS),
        whois,
    )?;
    for op in [PermOp::Allow, PermOp::Deny, PermOp::Clear] {
        let spec = CommandSpec::new(op.path(), op.description())
            .arg(role_arg())
            .arg(ArgSpec::new(
                "node",
                "權限節點,例如 queue.skip 或 queue.*",
                ArgKind::String,
            ))
            .arg(scope_arg())
            .permission(NODE_PERM);
        add(registry, service, spec, move |svc, inv| perm(svc, inv, op))?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum PermOp {
    Allow,
    Deny,
    Clear,
}

impl PermOp {
    fn path(self) -> &'static str {
        match self {
            Self::Allow => "admin perm allow",
            Self::Deny => "admin perm deny",
            Self::Clear => "admin perm clear",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::Allow => "在某個範圍允許角色使用權限節點",
            Self::Deny => "在某個範圍禁止角色使用權限節點",
            Self::Clear => "拿掉某個範圍的權限節點覆寫",
        }
    }
}

type Reply<T> = Result<T, CommandReply>;

fn no(text: impl Into<String>) -> CommandReply {
    CommandReply::ephemeral(text)
}

fn failed(e: &anyhow::Error) -> CommandReply {
    warn!(error = %format!("{e:#}"), "auth command failed");
    no(format!("失敗了啦:{e:#}"))
}

fn actor(inv: &Invocation) -> String {
    account_str(&inv.invoker)
}

fn who(account: &AccountRef) -> String {
    if account.platform.as_str() == "discord" {
        format!("<@{}>", account.id)
    } else {
        account_str(account)
    }
}

fn platform_role(inv: &Invocation, id: &str) -> String {
    if inv.context.platform.as_str() == "discord" {
        format!("<@&{id}>")
    } else {
        format!("`{id}`")
    }
}

fn scope_label(inv: &Invocation, scope: &AuthScope) -> String {
    match scope {
        AuthScope::Global => "全域".to_owned(),
        AuthScope::Guild { guild, .. } if inv.context.scope.as_deref() == Some(guild) => {
            "這個伺服器".to_owned()
        }
        AuthScope::Guild { guild, .. } => format!("伺服器 {guild}"),
        AuthScope::Channel { context } if context.channel == inv.context.channel => {
            "這個頻道".to_owned()
        }
        AuthScope::Channel { context } if context.platform.as_str() == "discord" => {
            format!("<#{}>", context.channel)
        }
        AuthScope::Channel { context } => format!("頻道 {}", context.channel),
    }
}

fn source_label(inv: &Invocation, source: &Source) -> String {
    match source {
        Source::ConfigOwner => "設定檔裡的主人".to_owned(),
        Source::Assignment { scope, granted_by } => {
            format!("{}的指派(由 {granted_by})", scope_label(inv, scope))
        }
        Source::PlatformRole { platform_role: r } => {
            format!("身分組 {} 的對應", platform_role(inv, r))
        }
        Source::GuildAdmin => "伺服器管理員".to_owned(),
        Source::Default => "預設角色".to_owned(),
    }
}

fn parse_scope(inv: &Invocation) -> Reply<AuthScope> {
    let guild = inv.context.scope.clone();
    let in_guild = |scope: AuthScope| {
        if guild.is_some() {
            Ok(scope)
        } else {
            Err(no("私訊裡沒有伺服器或頻道範圍啦,用 global。"))
        }
    };
    match (inv.str("scope"), &guild) {
        (None, None) | (Some("global"), _) => Ok(AuthScope::Global),
        (None | Some("guild"), _) => in_guild(AuthScope::Guild {
            platform: inv.context.platform.clone(),
            guild: guild.clone().unwrap_or_default(),
        }),
        (Some(_), _) => in_guild(AuthScope::Channel {
            context: inv.context.clone(),
        }),
    }
}

fn role_named(svc: &AuthService, inv: &Invocation) -> Reply<RoleDefinition> {
    let name = inv.str("role").unwrap_or_default().trim().to_lowercase();
    svc.role(&name).ok_or_else(|| {
        no(format!(
            "沒有 `{name}` 這個角色。用 `/admin role list` 看看有哪些。"
        ))
    })
}

/// The invoker as seen in `scope` (global changes are judged without the
/// guild context), checked against `node`.
fn authority(
    svc: &AuthService,
    inv: &Invocation,
    scope: &AuthScope,
    node: &str,
) -> Reply<(Subject, Resolution)> {
    let subject = match scope {
        AuthScope::Global => Subject::account(inv.invoker.clone()),
        _ => inv.subject(),
    };
    if !svc.check(&subject, node) {
        return Err(no("你在這個範圍沒有權限做這個啦。"));
    }
    let resolution = svc.resolve(&subject);
    Ok((subject, resolution))
}

fn outrank(resolution: &Resolution, role: &RoleDefinition) -> Reply<()> {
    if resolution.outranks(role.rank) {
        Ok(())
    } else {
        Err(no(format!(
            "`{}` 跟你一樣高或比你高,你不能動它。哼,想得美。",
            role.name
        )))
    }
}

async fn list(svc: Arc<AuthService>, inv: Invocation) -> CommandReply {
    let mut out = String::from("角色(由高到低):");
    for role in svc.roles() {
        let mut nodes: Vec<&str> = role.grants.iter().map(String::as_str).collect();
        let more = nodes.len().saturating_sub(SHOWN_NODES);
        nodes.truncate(SHOWN_NODES);
        let mut line = format!(
            "\n`{}` {}{} — {}",
            role.name,
            role.rank,
            if role.builtin { " · 內建" } else { "" },
            if nodes.is_empty() {
                "(什麼都不能做)".to_owned()
            } else {
                nodes.join(", ")
            }
        );
        if more > 0 {
            line.push_str(&format!(" …還有 {more} 個"));
        }
        if !role.denies.is_empty() {
            line.push_str(&format!(";禁止 {}", role.denies.join(", ")));
        }
        out.push_str(&line);
    }
    if let Some(guild) = &inv.context.scope {
        match svc.mappings(&inv.context.platform, guild).await {
            Ok(maps) if !maps.is_empty() => {
                out.push_str("\n\n這個伺服器的身分組對應:");
                for m in maps {
                    out.push_str(&format!(
                        "\n{} → `{}`",
                        platform_role(&inv, &m.platform_role),
                        m.role
                    ));
                }
            }
            Ok(_) => {}
            Err(e) => return failed(&e),
        }
    }
    let overrides: Vec<NodeOverride> = svc
        .overrides()
        .into_iter()
        .filter(|o| scope_covers(&o.scope, Some(&inv.context)))
        .collect();
    if !overrides.is_empty() {
        out.push_str("\n\n在這裡生效的覆寫:");
        for o in overrides {
            out.push_str(&format!(
                "\n`{}` 在{}{} `{}`",
                o.role,
                scope_label(&inv, &o.scope),
                if o.allow { "允許" } else { "禁止" },
                o.node
            ));
        }
    }
    CommandReply::ephemeral(out)
}

async fn assign(svc: Arc<AuthService>, inv: Invocation, revoke: bool) -> CommandReply {
    match try_assign(&svc, &inv, revoke).await {
        Ok(reply) | Err(reply) => reply,
    }
}

async fn try_assign(svc: &AuthService, inv: &Invocation, revoke: bool) -> Reply<CommandReply> {
    let target = inv.account("user").ok_or_else(|| no("要指定一個人啦。"))?;
    let role = role_named(svc, inv)?;
    let scope = parse_scope(inv)?;
    let (_, me) = authority(svc, inv, &scope, NODE_ASSIGN)?;
    outrank(&me, &role)?;
    let target_subject = match &scope {
        AuthScope::Global => Subject::account(target.clone()),
        _ => inv.subject_for(&target),
    };
    if target != inv.invoker && !me.outranks(svc.resolve(&target_subject).effective.rank) {
        return Err(no(format!(
            "{} 的角色跟你一樣高或比你高,我才不聽你的。",
            who(&target)
        )));
    }
    let place = scope_label(inv, &scope);
    if revoke {
        return match svc.revoke(&actor(inv), &target, &role.name, &scope).await {
            Ok(true) => Ok(no(format!(
                "好,收回了 {} 在{place}的 `{}`。",
                who(&target),
                role.name
            ))),
            Ok(false) => Ok(no(format!(
                "{} 在{place}本來就沒有被指派 `{}` 啊。",
                who(&target),
                role.name
            ))),
            Err(e) => Err(failed(&e)),
        };
    }
    svc.assign(&actor(inv), &target, &role.name, scope)
        .await
        .map_err(|e| failed(&e))?;
    let mut text = format!(
        "好啦,{} 在{place}是 `{}` 了。感謝我吧。",
        who(&target),
        role.name
    );
    let effective = svc.resolve(&inv.subject_for(&target)).effective;
    if effective.role != role.name {
        text.push_str(&format!(
            "\n(不過他在這裡實際生效的是 `{}`。)",
            effective.role
        ));
    }
    Ok(no(text))
}

async fn map(svc: Arc<AuthService>, inv: Invocation) -> CommandReply {
    match try_map(&svc, &inv, false).await {
        Ok(reply) | Err(reply) => reply,
    }
}

async fn unmap(svc: Arc<AuthService>, inv: Invocation) -> CommandReply {
    match try_map(&svc, &inv, true).await {
        Ok(reply) | Err(reply) => reply,
    }
}

async fn try_map(svc: &AuthService, inv: &Invocation, remove: bool) -> Reply<CommandReply> {
    let Some(guild) = inv.context.scope.clone() else {
        return Err(no("身分組對應只能在伺服器裡設定。"));
    };
    let platform = inv.context.platform.clone();
    let discord_role = inv.str("discord_role").unwrap_or_default().to_owned();
    let (_, me) = authority(
        svc,
        inv,
        &AuthScope::Guild {
            platform: platform.clone(),
            guild: guild.clone(),
        },
        NODE_MAP,
    )?;
    let existing = svc
        .mappings(&platform, &guild)
        .await
        .map_err(|e| failed(&e))?
        .into_iter()
        .find(|m| m.platform_role == discord_role);
    if let Some(old) = existing.as_ref().and_then(|m| svc.role(&m.role)) {
        outrank(&me, &old)?;
    }
    let shown = platform_role(inv, &discord_role);
    if remove {
        if existing.is_none() {
            return Ok(no(format!("{shown} 本來就沒有對應啊。")));
        }
        svc.unmap_role(&actor(inv), &platform, &guild, &discord_role)
            .await
            .map_err(|e| failed(&e))?;
        return Ok(no(format!("好,{shown} 不再對應任何角色了。")));
    }
    let role = role_named(svc, inv)?;
    outrank(&me, &role)?;
    let mapping = RoleMapping {
        platform,
        guild,
        platform_role: discord_role,
        role: role.name.clone(),
    };
    svc.map_role(&actor(inv), mapping)
        .await
        .map_err(|e| failed(&e))?;
    Ok(no(format!(
        "好,在這個伺服器有 {shown} 的人就是 `{}`。",
        role.name
    )))
}

async fn whois(svc: Arc<AuthService>, inv: Invocation) -> CommandReply {
    let target = inv.account("user").unwrap_or_else(|| inv.invoker.clone());
    let subject = inv.subject_for(&target);
    svc.preload(&subject).await;
    let r = svc.resolve(&subject);
    let mut out = format!(
        "{} 在這裡是 `{}`(rank {})。\n原因:{}",
        who(&target),
        r.effective.role,
        r.effective.rank,
        source_label(&inv, &r.effective.source)
    );
    let others: Vec<String> = r
        .candidates
        .iter()
        .filter(|c| **c != r.effective)
        .map(|c| format!("`{}`({})", c.role, source_label(&inv, &c.source)))
        .collect();
    if !others.is_empty() {
        out.push_str(&format!("\n也符合:{}", others.join("、")));
    }
    let unknown = target != inv.invoker
        && target.platform == inv.context.platform
        && !inv.resolved_users.contains_key(&target.id);
    if unknown && inv.context.scope.is_some() {
        out.push_str("\n(看不到對方的身分組,只算了指派的角色。)");
    }
    CommandReply::ephemeral(out)
}

async fn perm(svc: Arc<AuthService>, inv: Invocation, op: PermOp) -> CommandReply {
    match try_perm(&svc, &inv, op).await {
        Ok(reply) | Err(reply) => reply,
    }
}

async fn try_perm(svc: &AuthService, inv: &Invocation, op: PermOp) -> Reply<CommandReply> {
    let role = role_named(svc, inv)?;
    let node = inv.str("node").unwrap_or_default().trim().to_owned();
    if !is_valid_pattern(&node) {
        return Err(no(format!(
            "`{node}` 格式不對,要像 `queue.skip` 或 `queue.*` 這樣。"
        )));
    }
    let scope = parse_scope(inv)?;
    let (me_subject, me) = authority(svc, inv, &scope, NODE_PERM)?;
    outrank(&me, &role)?;
    // Allowing (or lifting a deny) must not hand out more than one has.
    if !matches!(op, PermOp::Deny) && !svc.check(&me_subject, &node) {
        return Err(no(format!("你自己都不能用 `{node}`,不能給別人啦。")));
    }
    let place = scope_label(inv, &scope);
    match op {
        PermOp::Clear => match svc
            .remove_override(&actor(inv), &scope, &role.name, &node)
            .await
        {
            Ok(true) => Ok(no(format!(
                "好,拿掉了 `{}` 在{place}對 `{node}` 的覆寫。",
                role.name
            ))),
            Ok(false) => Ok(no(format!(
                "`{}` 在{place}本來就沒有 `{node}` 的覆寫啊。",
                role.name
            ))),
            Err(e) => Err(failed(&e)),
        },
        PermOp::Allow | PermOp::Deny => {
            let allow = matches!(op, PermOp::Allow);
            let node_override = NodeOverride {
                scope,
                role: role.name.clone(),
                node: node.clone(),
                allow,
            };
            svc.set_override(&actor(inv), node_override)
                .await
                .map_err(|e| failed(&e))?;
            Ok(no(format!(
                "好,`{}` 在{place}{} `{node}` 了。",
                role.name,
                if allow { "可以用" } else { "不能用" }
            )))
        }
    }
}
