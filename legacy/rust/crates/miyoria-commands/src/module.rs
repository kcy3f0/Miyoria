use std::sync::Arc;

use async_trait::async_trait;
use miyoria_kernel::{
    Module, ModuleContext, ModuleManifest, ModuleStatus, SupervisorHandle, TopicFilter,
};
use miyoria_types::{Authorizer, ModuleId, ModuleStateKind};
use serde::Deserialize;

use crate::perms::Permissions;
use crate::registry::CommandRegistry;
use crate::spec::{ArgKind, ArgSpec, CommandReply, CommandSpec, Invocation};

/// `[modules.commands]` config section.
///
/// ```toml
/// [modules.commands]
/// owners = ["discord:123456789012345678"]
/// ```
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct CommandsConfig {
    /// Accounts with the `owner` role, as `"platform:id"`.
    pub owners: Vec<String>,
}

/// Module `commands`: provides `Arc<CommandRegistry>` and registers the
/// built-in commands (`ping`, `admin module ...`).
///
/// It also provides its [`Permissions`] as a fallback `Arc<dyn Authorizer>`
/// whenever no other module (normally `auth`) provides one, and puts it back
/// after that module stops.
pub struct CommandsModule {
    manifest: ModuleManifest,
}

impl Default for CommandsModule {
    fn default() -> Self {
        Self::new()
    }
}

impl CommandsModule {
    pub const ID: &'static str = "commands";

    pub fn new() -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Commands")
                .description("Cross-platform command framework and built-in commands"),
        }
    }
}

#[async_trait]
impl Module for CommandsModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let config: CommandsConfig = ctx.config()?;
        let perms = Permissions::from_strings(&config.owners)?;
        let registry = Arc::new(CommandRegistry::new(perms.clone()).with_services(ctx.clone()));
        register_builtins(&registry, &ctx)?;
        ctx.provide(registry);
        let fallback: Arc<dyn Authorizer> = Arc::new(perms);
        provide_fallback(&ctx, &fallback);

        let mut events = ctx.subscribe(TopicFilter::new(["system.module.state"]));
        let cancel = ctx.cancellation().clone();
        let c = ctx.clone();
        ctx.spawn("authorizer-fallback", async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => return Ok(()),
                    env = events.recv() => match env {
                        Some(_) => provide_fallback(&c, &fallback),
                        None => return Ok(()),
                    },
                }
            }
        });
        Ok(())
    }
}

fn provide_fallback(ctx: &ModuleContext, fallback: &Arc<dyn Authorizer>) {
    if ctx.services().get::<dyn Authorizer>().is_none() {
        ctx.provide(fallback.clone());
    }
}

/// Registers `ping` and `admin module list | enable | disable | restart`.
///
/// The admin commands look up [`SupervisorHandle`] when they run, so the app
/// may provide it after this module started.
pub fn register_builtins(registry: &CommandRegistry, ctx: &ModuleContext) -> anyhow::Result<()> {
    registry.register(
        CommandSpec::new("ping", "確認 Miyoria 還醒著").permission("ping"),
        |_| async { Ok(CommandReply::public("pong!……才、才不是特地回你的。")) },
    )?;

    registry.set_group_description("admin", "管理指令");
    registry.set_group_description("admin module", "管理模組");

    let c = ctx.clone();
    registry.register(
        CommandSpec::new("admin module list", "列出所有模組與狀態")
            .permission("admin.module.list")
            .ephemeral(true),
        move |_| {
            let c = c.clone();
            async move {
                let Some(sup) = supervisor(&c) else {
                    return Ok(no_supervisor());
                };
                Ok(CommandReply::ephemeral(format_module_list(
                    &sup.list().await,
                )))
            }
        },
    )?;

    for op in [Op::Enable, Op::Disable, Op::Restart] {
        let c = ctx.clone();
        let spec = CommandSpec::new(op.path(), op.description())
            .arg(ArgSpec::new("id", "模組 id,例如 llm", ArgKind::String))
            .permission(op.permission())
            .ephemeral(true);
        registry.register(spec, move |inv: Invocation| {
            let c = c.clone();
            async move {
                let Some(sup) = supervisor(&c) else {
                    return Ok(no_supervisor());
                };
                let id = ModuleId::from(inv.str("id").unwrap_or_default().trim());
                Ok(CommandReply::ephemeral(run_op(&sup, op, &id).await))
            }
        })?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum Op {
    Enable,
    Disable,
    Restart,
}

impl Op {
    fn path(self) -> &'static str {
        match self {
            Self::Enable => "admin module enable",
            Self::Disable => "admin module disable",
            Self::Restart => "admin module restart",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::Enable => "啟用模組",
            Self::Disable => "停用模組(依賴它的模組也會停)",
            Self::Restart => "重新啟動模組",
        }
    }

    fn permission(self) -> &'static str {
        match self {
            Self::Enable | Self::Disable => "admin.module.toggle",
            Self::Restart => "admin.module.restart",
        }
    }
}

async fn run_op(sup: &SupervisorHandle, op: Op, id: &ModuleId) -> String {
    if matches!(op, Op::Disable) && id.as_str() == CommandsModule::ID {
        return "不要啦,停掉 `commands` 我就聽不到指令了。真的要停請用 CLI 或 Panel。".to_owned();
    }
    let result = match op {
        Op::Enable => sup.enable(id).await,
        Op::Disable => sup.disable(id).await,
        Op::Restart => sup.restart(id).await,
    };
    match (result, op) {
        (Ok(()), Op::Enable) => format!("`{id}` 啟用了。哼,感謝我吧。"),
        (Ok(()), Op::Disable) => format!("`{id}` 停用了。"),
        (Ok(()), Op::Restart) => format!("`{id}` 重新啟動好了。"),
        (Err(e), _) => format!("失敗了啦:{e:#}"),
    }
}

fn supervisor(ctx: &ModuleContext) -> Option<Arc<SupervisorHandle>> {
    ctx.services().get::<SupervisorHandle>()
}

fn no_supervisor() -> CommandReply {
    CommandReply::ephemeral("現在沒辦法管理模組(supervisor 不在),這不是我的錯喔。")
}

fn state_label(state: ModuleStateKind) -> &'static str {
    match state {
        ModuleStateKind::Disabled => "disabled",
        ModuleStateKind::Starting => "starting",
        ModuleStateKind::Running => "running",
        ModuleStateKind::Degraded => "degraded",
        ModuleStateKind::Stopping => "stopping",
        ModuleStateKind::Stopped => "stopped",
        ModuleStateKind::Failed => "failed",
    }
}

/// One line per module: `` `id` (name): state — reason ``.
pub fn format_module_list(modules: &[ModuleStatus]) -> String {
    if modules.is_empty() {
        return "一個模組都沒有……".to_owned();
    }
    let mut out = String::from("模組狀態:");
    for m in modules {
        out.push_str(&format!(
            "\n`{}` ({}): {}",
            m.id,
            m.name,
            state_label(m.state)
        ));
        if m.recent_restarts > 0 {
            out.push_str(&format!(",最近重啟 {} 次", m.recent_restarts));
        }
        if let Some(reason) = &m.reason {
            out.push_str(&format!(" — {reason}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use miyoria_kernel::{EventBus, ServiceRegistry, Supervisor};
    use miyoria_types::{ContextKey, ContextKind, PlatformId};

    use super::*;
    use crate::perms::parse_account;
    use crate::spec::ArgValue;

    struct Dummy {
        manifest: ModuleManifest,
    }

    #[async_trait]
    impl Module for Dummy {
        fn manifest(&self) -> &ModuleManifest {
            &self.manifest
        }

        async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
            let cancel = ctx.cancellation().clone();
            ctx.spawn("idle", async move {
                cancel.cancelled().await;
                Ok(())
            });
            Ok(())
        }
    }

    async fn boot() -> (Supervisor, Arc<CommandRegistry>) {
        let services = Arc::new(ServiceRegistry::new());
        let sup = Supervisor::new(EventBus::default(), services.clone());
        services.provide::<SupervisorHandle>(&ModuleId::from("app"), Arc::new(sup.clone()));
        sup.register(
            Arc::new(CommandsModule::new()),
            serde_json::json!({ "owners": ["discord:1"] }),
            true,
        )
        .await;
        sup.register(
            Arc::new(Dummy {
                manifest: ModuleManifest::new("dummy", "Dummy"),
            }),
            serde_json::Value::Null,
            true,
        )
        .await;
        sup.start_all().await.unwrap();
        let registry = services.require::<CommandRegistry>().unwrap();
        (sup, registry)
    }

    fn inv(path: &str, invoker: &str, id: Option<&str>) -> Invocation {
        let mut args = BTreeMap::new();
        if let Some(id) = id {
            args.insert("id".to_owned(), ArgValue::String(id.to_owned()));
        }
        Invocation {
            path: path.split(' ').map(str::to_owned).collect(),
            args,
            invoker: parse_account(&format!("discord:{invoker}")).unwrap(),
            invoker_display_name: "someone".into(),
            context: ContextKey {
                platform: PlatformId::new("discord"),
                scope: Some("10".into()),
                channel: "20".into(),
                kind: ContextKind::Channel,
            },
            invoker_is_guild_admin: false,
            platform_roles: Vec::new(),
            resolved_users: BTreeMap::new(),
        }
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
    async fn builtins_are_registered() {
        let (sup, reg) = boot().await;
        let names: Vec<String> = reg.specs().iter().map(CommandSpec::name).collect();
        assert_eq!(
            names,
            [
                "admin module disable",
                "admin module enable",
                "admin module list",
                "admin module restart",
                "ping"
            ]
        );
        let pong = reg.dispatch(inv("ping", "5", None)).await.unwrap();
        assert!(pong.text.starts_with("pong") && !pong.ephemeral);
        let auth = sup.services().require::<dyn Authorizer>().unwrap();
        assert!(auth.allows(&parse_account("discord:1").unwrap(), "admin.x"));
        assert!(!auth.allows(&parse_account("discord:5").unwrap(), "admin.x"));
        sup.stop_all().await;
        assert!(sup.services().get::<dyn Authorizer>().is_none());
    }

    #[tokio::test]
    async fn admin_module_commands() {
        let (sup, reg) = boot().await;

        let denied = reg
            .dispatch(inv("admin module disable", "5", Some("dummy")))
            .await
            .unwrap();
        assert!(denied.ephemeral && denied.text.contains("權限"));
        assert_eq!(state(&sup, "dummy").await, ModuleStateKind::Running);

        let list = reg
            .dispatch(inv("admin module list", "1", None))
            .await
            .unwrap();
        assert!(list.ephemeral);
        assert!(
            list.text.contains("`dummy` (Dummy): running"),
            "{}",
            list.text
        );

        reg.dispatch(inv("admin module disable", "1", Some("dummy")))
            .await
            .unwrap();
        assert_eq!(state(&sup, "dummy").await, ModuleStateKind::Disabled);

        let mut admin = inv("admin module enable", "5", Some("dummy"));
        admin.invoker_is_guild_admin = true;
        let reply = reg.dispatch(admin).await.unwrap();
        assert!(reply.text.contains("啟用了"), "{}", reply.text);
        assert_eq!(state(&sup, "dummy").await, ModuleStateKind::Running);

        let reply = reg
            .dispatch(inv("admin module restart", "1", Some("dummy")))
            .await
            .unwrap();
        assert!(reply.text.contains("重新啟動好了"), "{}", reply.text);
        assert_eq!(state(&sup, "dummy").await, ModuleStateKind::Running);

        let unknown = reg
            .dispatch(inv("admin module enable", "1", Some("ghost")))
            .await
            .unwrap();
        assert!(unknown.text.contains("失敗"), "{}", unknown.text);

        let protected = reg
            .dispatch(inv("admin module disable", "1", Some("commands")))
            .await
            .unwrap();
        assert!(protected.text.contains("CLI"));
        assert_eq!(state(&sup, "commands").await, ModuleStateKind::Running);

        let missing_arg = reg
            .dispatch(inv("admin module enable", "1", None))
            .await
            .unwrap();
        assert!(missing_arg.text.contains("少了「id」"));
        sup.stop_all().await;
    }

    #[tokio::test]
    async fn restarting_commands_provides_a_fresh_registry() {
        let (sup, reg) = boot().await;
        reg.dispatch(inv("admin module restart", "1", Some("commands")))
            .await
            .unwrap();
        let fresh = sup.services().require::<CommandRegistry>().unwrap();
        assert!(!Arc::ptr_eq(&reg, &fresh));
        assert_eq!(fresh.specs().len(), 5);
        sup.stop_all().await;
    }

    /// Allows only `ping` and `admin.module.list`, and only in guild `10`.
    struct GuildOnly;

    impl Authorizer for GuildOnly {
        fn allows_subject(&self, subject: &miyoria_types::Subject, node: &str) -> bool {
            let in_guild = subject
                .context
                .as_ref()
                .is_some_and(|c| c.scope.as_deref() == Some("10"));
            in_guild
                && subject.platform_roles == ["r1"]
                && matches!(node, "ping" | "admin.module.list")
        }
    }

    #[derive(Default)]
    struct Audit(parking_lot::Mutex<Vec<miyoria_store::AuditEntry>>);

    #[async_trait]
    impl miyoria_store::AuditLog for Audit {
        async fn append(&self, entry: &miyoria_store::AuditEntry) -> anyhow::Result<()> {
            self.0.lock().push(entry.clone());
            Ok(())
        }

        async fn recent(
            &self,
            _limit: usize,
            _actor: Option<&str>,
        ) -> anyhow::Result<Vec<miyoria_store::AuditEntry>> {
            Ok(self.0.lock().clone())
        }
    }

    #[tokio::test]
    async fn uses_the_authorizer_service_and_audits() {
        let services = Arc::new(ServiceRegistry::new());
        let app = ModuleId::from("app");
        let audit = Arc::new(Audit::default());
        services.provide::<dyn Authorizer>(&app, Arc::new(GuildOnly));
        services.provide::<dyn miyoria_store::AuditLog>(&app, audit.clone());
        let sup = Supervisor::new(EventBus::default(), services.clone());
        sup.register(
            Arc::new(CommandsModule::new()),
            serde_json::json!({ "owners": ["discord:1"] }),
            true,
        )
        .await;
        sup.start_all().await.unwrap();
        let reg = services.require::<CommandRegistry>().unwrap();

        // The owner is denied: the service decides, not the fallback.
        let denied = reg
            .dispatch(inv("admin module list", "1", None))
            .await
            .unwrap();
        assert!(denied.text.contains("權限"), "{}", denied.text);
        let mut with_role = inv("admin module list", "5", None);
        with_role.platform_roles = vec!["r1".into()];
        let listed = reg.dispatch(with_role).await.unwrap();
        // Reached the handler (no supervisor in this test).
        assert!(listed.text.contains("supervisor"), "{}", listed.text);
        let mut ping = inv("ping", "5", None);
        ping.platform_roles = vec!["r1".into()];
        assert!(reg.dispatch(ping).await.unwrap().text.starts_with("pong"));

        // Only admin nodes are audited, denials too.
        let entries = audit.0.lock().clone();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].action, "admin module list");
        assert_eq!(entries[0].actor, "discord:1");
        assert!(!entries[0].ok);
        assert_eq!(entries[0].detail["outcome"], "denied");
        assert_eq!(entries[1].actor, "discord:5");
        assert!(entries[1].ok);
        // The app's authorizer was kept.
        assert!(
            !services
                .require::<dyn Authorizer>()
                .unwrap()
                .allows(&parse_account("discord:1").unwrap(), "x")
        );
        sup.stop_all().await;
    }

    #[test]
    fn rejects_bad_owner_config() {
        assert!(Permissions::from_strings(&["123"]).is_err());
        let cfg: CommandsConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(cfg.owners.is_empty());
    }
}
