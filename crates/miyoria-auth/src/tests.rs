//! Module tests: `commands` + `auth` under a real supervisor, with an
//! in-memory store.

use std::sync::Arc;
use std::time::Duration;

use miyoria_commands::{
    ArgValue, CommandRegistry, CommandReply, CommandSpec, CommandsModule, Invocation,
};
use miyoria_kernel::{EventBus, ServiceRegistry, Supervisor};
use miyoria_store::{AuditLog, AuthStore, RoleMapping};
use miyoria_types::{
    AccountRef, Authorizer, ContextKey, ContextKind, ModuleId, PlatformId, Subject,
};

use crate::fake::{FakeAudit, FakeAuthStore};
use crate::{AuthModule, AuthService};

struct Harness {
    sup: Supervisor,
    store: Arc<FakeAuthStore>,
    audit: Arc<FakeAudit>,
}

fn acc(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: id.into(),
    }
}

fn ctx(guild: &str) -> ContextKey {
    ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some(guild.into()),
        channel: format!("{guild}-chan"),
        kind: ContextKind::Channel,
    }
}

fn subject(id: &str, guild: &str, roles: &[&str]) -> Subject {
    Subject {
        account: acc(id),
        context: Some(ctx(guild)),
        platform_roles: roles.iter().map(|s| (*s).to_owned()).collect(),
        is_guild_admin: false,
    }
}

impl Harness {
    async fn boot(store: FakeAuthStore) -> Self {
        let store = Arc::new(store);
        let audit = Arc::new(FakeAudit::default());
        let services = Arc::new(ServiceRegistry::new());
        let app = ModuleId::from("app");
        services.provide::<dyn AuthStore>(&app, store.clone());
        services.provide::<dyn AuditLog>(&app, audit.clone());
        let sup = Supervisor::new(EventBus::default(), services);
        sup.register(
            Arc::new(CommandsModule::new()),
            serde_json::json!({ "owners": ["discord:1"] }),
            true,
        )
        .await;
        sup.register(Arc::new(AuthModule::new()), serde_json::Value::Null, true)
            .await;
        sup.start_all().await.unwrap();
        Self { sup, store, audit }
    }

    fn registry(&self) -> Arc<CommandRegistry> {
        self.sup.services().require::<CommandRegistry>().unwrap()
    }

    fn authorizer(&self) -> Arc<dyn Authorizer> {
        self.sup.services().require::<dyn Authorizer>().unwrap()
    }

    async fn run(&self, inv: Invocation) -> String {
        self.registry().dispatch(inv).await.unwrap().text
    }
}

/// `path` with `args`, by `who` in guild `g1`.
fn inv(path: &str, who: &str, args: &[(&str, &str)]) -> Invocation {
    let mut inv = Invocation::new(path, acc(who), ctx("g1"));
    for (k, v) in args {
        inv = inv.with_arg(*k, ArgValue::String((*v).to_owned()));
    }
    inv
}

fn as_guild_admin(mut inv: Invocation) -> Invocation {
    inv.invoker_is_guild_admin = true;
    inv
}

async fn eventually(mut f: impl FnMut() -> bool) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached");
}

#[tokio::test]
async fn seeds_roles_and_replaces_the_fallback() {
    let h = Harness::boot(FakeAuthStore::default()).await;
    assert_eq!(h.store.roles.lock().len(), 7);
    let auth = h.authorizer();
    assert!(auth.allows(&acc("1"), "owner.shutdown"));
    // The fallback would allow unknown non-admin nodes; RBAC does not.
    assert!(!auth.allows(&acc("5"), "zzz.unknown"));
    assert!(auth.allows(&acc("5"), "voice.join"));
    let mut admin = subject("2", "g1", &[]);
    admin.is_guild_admin = true;
    assert!(auth.allows_subject(&admin, "admin.module.toggle"));
    assert!(!auth.allows_subject(&admin, "owner.shutdown"));
    assert!(
        h.registry()
            .get(&["admin".into(), "role".into(), "list".into()])
            .is_some()
    );

    let list = h.run(inv("admin role list", "1", &[])).await;
    assert!(list.contains("`owner` 100"), "{list}");
    assert!(list.contains("`blocked` 0"), "{list}");
    let denied = h.run(inv("admin role list", "5", &[])).await;
    assert!(denied.contains("權限"), "{denied}");
    h.sup.stop_all().await;
}

#[tokio::test]
async fn assign_revoke_and_rank_limits() {
    let h = Harness::boot(FakeAuthStore::default()).await;
    let auth = h.authorizer();

    let reply = h
        .run(as_guild_admin(inv(
            "admin role assign",
            "2",
            &[("user", "<@5>"), ("role", "moderator")],
        )))
        .await;
    assert!(reply.contains("是 `moderator` 了"), "{reply}");
    assert!(auth.allows_subject(&subject("5", "g1", &[]), "admin.channel.mode"));
    assert!(!auth.allows_subject(&subject("5", "g2", &[]), "admin.channel.mode"));

    // Same rank as the guild admin: refused.
    let reply = h
        .run(as_guild_admin(inv(
            "admin role assign",
            "2",
            &[("user", "5"), ("role", "admin")],
        )))
        .await;
    assert!(reply.contains("不能動它"), "{reply}");
    // Global changes need global authority.
    let reply = h
        .run(as_guild_admin(inv(
            "admin role assign",
            "2",
            &[("user", "5"), ("role", "trusted"), ("scope", "global")],
        )))
        .await;
    assert!(reply.contains("沒有權限"), "{reply}");

    // The owner may grant admin globally; the guild admin cannot then block them.
    let reply = h
        .run(inv(
            "admin role assign",
            "1",
            &[("user", "6"), ("role", "admin"), ("scope", "global")],
        ))
        .await;
    assert!(reply.contains("全域是 `admin`"), "{reply}");
    assert!(auth.allows(&acc("6"), "admin.module.toggle"));
    let reply = h
        .run(as_guild_admin(inv(
            "admin role assign",
            "2",
            &[("user", "6"), ("role", "blocked")],
        )))
        .await;
    assert!(reply.contains("我才不聽你的"), "{reply}");

    let reply = h
        .run(as_guild_admin(inv(
            "admin role revoke",
            "2",
            &[("user", "5"), ("role", "moderator")],
        )))
        .await;
    assert!(reply.contains("收回了"), "{reply}");
    assert!(!auth.allows_subject(&subject("5", "g1", &[]), "admin.channel.mode"));
    let reply = h
        .run(as_guild_admin(inv(
            "admin role revoke",
            "2",
            &[("user", "5"), ("role", "moderator")],
        )))
        .await;
    assert!(reply.contains("本來就沒有"), "{reply}");

    let unknown = h
        .run(inv(
            "admin role assign",
            "1",
            &[("user", "5"), ("role", "ghost")],
        ))
        .await;
    assert!(unknown.contains("沒有 `ghost`"), "{unknown}");

    let actions = h.audit.actions();
    assert!(
        actions.contains(&("role.assign".into(), true)),
        "{actions:?}"
    );
    assert!(
        actions.contains(&("role.revoke".into(), true)),
        "{actions:?}"
    );
    assert!(
        actions.contains(&("admin role assign".into(), true)),
        "{actions:?}"
    );
    h.sup.stop_all().await;
}

#[tokio::test]
async fn mappings_are_preloaded_and_managed() {
    let store = FakeAuthStore::default();
    store.mappings.lock().push(RoleMapping {
        platform: PlatformId::new("discord"),
        guild: "g1".into(),
        platform_role: "r-trusted".into(),
        role: "trusted".into(),
    });
    let h = Harness::boot(store).await;
    h.registry()
        .register(
            CommandSpec::new("probe", "Needs a trusted node").permission("tools.web"),
            |_| async { Ok(CommandReply::public("ok")) },
        )
        .unwrap();

    // Not cached yet: dispatch preloads the guild's mappings first.
    let mut probe = inv("probe", "7", &[]);
    probe.platform_roles = vec!["r-trusted".into()];
    assert_eq!(h.run(probe).await, "ok");
    assert_ne!(h.run(inv("probe", "7", &[])).await, "ok");

    let reply = h
        .run(as_guild_admin(inv(
            "admin role map",
            "2",
            &[("discord_role", "<@&r-mod>"), ("role", "moderator")],
        )))
        .await;
    assert!(reply.contains("就是 `moderator`"), "{reply}");
    let auth = h.authorizer();
    assert!(auth.allows_subject(&subject("8", "g1", &["r-mod"]), "admin.channel.mode"));
    let reply = h
        .run(as_guild_admin(inv(
            "admin role map",
            "2",
            &[("discord_role", "r-adm"), ("role", "admin")],
        )))
        .await;
    assert!(reply.contains("不能動它"), "{reply}");

    let mut whois = inv("admin role whois", "1", &[("user", "8")]);
    whois.resolved_users.insert(
        "8".into(),
        miyoria_commands::ResolvedUser {
            display_name: "eight".into(),
            platform_roles: vec!["r-mod".into(), "r-trusted".into()],
            is_guild_admin: false,
        },
    );
    let reply = h.run(whois).await;
    assert!(reply.contains("是 `moderator`"), "{reply}");
    assert!(reply.contains("<@&r-mod> 的對應"), "{reply}");
    assert!(reply.contains("`trusted`"), "{reply}");

    let unmap = || as_guild_admin(inv("admin role unmap", "2", &[("discord_role", "r-mod")]));
    assert!(h.run(unmap()).await.contains("不再對應"));
    assert!(h.run(unmap()).await.contains("本來就沒有"));
    assert!(!auth.allows_subject(&subject("8", "g1", &["r-mod"]), "admin.channel.mode"));
    h.sup.stop_all().await;
}

#[tokio::test]
async fn node_overrides() {
    let h = Harness::boot(FakeAuthStore::default()).await;
    let auth = h.authorizer();
    let reply = h
        .run(as_guild_admin(inv(
            "admin perm deny",
            "2",
            &[("role", "user"), ("node", "voice.join")],
        )))
        .await;
    assert!(reply.contains("不能用 `voice.join`"), "{reply}");
    assert!(!auth.allows_subject(&subject("9", "g1", &[]), "voice.join"));
    assert!(auth.allows_subject(&subject("9", "g2", &[]), "voice.join"));

    let reply = h
        .run(as_guild_admin(inv(
            "admin perm allow",
            "2",
            &[("role", "user"), ("node", "owner.shutdown")],
        )))
        .await;
    assert!(reply.contains("你自己都不能用"), "{reply}");
    let reply = h
        .run(as_guild_admin(inv(
            "admin perm allow",
            "2",
            &[("role", "user"), ("node", "Bad Node")],
        )))
        .await;
    assert!(reply.contains("格式不對"), "{reply}");

    let reply = h
        .run(as_guild_admin(inv(
            "admin perm clear",
            "2",
            &[("role", "user"), ("node", "voice.join")],
        )))
        .await;
    assert!(reply.contains("拿掉了"), "{reply}");
    assert!(auth.allows_subject(&subject("9", "g1", &[]), "voice.join"));
    assert!(h.audit.actions().contains(&("perm.set".into(), true)));
    h.sup.stop_all().await;
}

#[tokio::test]
async fn survives_commands_restart_and_restores_fallback_on_stop() {
    let h = Harness::boot(FakeAuthStore::default()).await;
    let path = ["admin".to_owned(), "role".to_owned(), "list".to_owned()];
    h.sup.restart(&ModuleId::from("commands")).await.unwrap();
    let services = h.sup.services();
    eventually(|| {
        services
            .get::<CommandRegistry>()
            .is_some_and(|r| r.get(&path).is_some())
    })
    .await;
    // Still the RBAC authorizer.
    assert!(!h.authorizer().allows(&acc("5"), "zzz.unknown"));
    assert!(services.get::<AuthService>().is_some());

    h.sup.disable(&ModuleId::from("auth")).await.unwrap();
    eventually(|| {
        services
            .get::<dyn Authorizer>()
            .is_some_and(|a| a.allows(&acc("5"), "zzz.unknown"))
    })
    .await;
    assert!(h.registry().get(&path).is_none());

    h.sup.enable(&ModuleId::from("auth")).await.unwrap();
    assert!(!h.authorizer().allows(&acc("5"), "zzz.unknown"));
    assert!(h.registry().get(&path).is_some());
    h.sup.stop_all().await;
}
