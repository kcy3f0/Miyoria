use std::sync::Arc;

use miyoria_commands::{
    ArgValue, CommandRegistry, CommandReply, CommandsModule, Invocation, Permissions, parse_account,
};
use miyoria_kernel::{EventBus, ServiceRegistry, Supervisor, TopicFilter};
use miyoria_queue::{QueueConfig, QueueModule, QueuePermissions, RequestQueue, register_commands};
use miyoria_store::{SettingsStore, Store};
use miyoria_types::{ContextKey, ContextKind, Event, ModuleId, PlatformId, ProfileId};

fn inv(path: &str, who: &str, args: &[(&str, ArgValue)]) -> Invocation {
    let context = ContextKey {
        platform: PlatformId::new("discord"),
        scope: Some("1".into()),
        channel: "2".into(),
        kind: ContextKind::Channel,
    };
    let mut inv = Invocation::new(
        path,
        parse_account(&format!("discord:{who}")).unwrap(),
        context,
    );
    inv.invoker_display_name = format!("user{who}");
    for (name, value) in args {
        inv = inv.with_arg(*name, value.clone());
    }
    inv
}

fn s(v: &str) -> ArgValue {
    ArgValue::String(v.to_owned())
}

fn setup(config: QueueConfig) -> (Arc<RequestQueue>, CommandRegistry) {
    let registry = CommandRegistry::new(Permissions::from_strings(&["discord:1"]).unwrap());
    let queue = Arc::new(RequestQueue::new(config));
    register_commands(&registry, &queue).unwrap();
    (queue, registry)
}

async fn run(
    reg: &CommandRegistry,
    path: &str,
    who: &str,
    args: &[(&str, ArgValue)],
) -> CommandReply {
    reg.dispatch(inv(path, who, args)).await.unwrap()
}

#[tokio::test]
async fn request_and_queue_commands() {
    let (queue, reg) = setup(QueueConfig::default());

    let r = run(
        &reg,
        "request",
        "5",
        &[("text", s("唱一首歌")), ("kind", s("song"))],
    )
    .await;
    assert_eq!(r.text, "收到啦,#1 排第 1 個。");
    assert!(!r.ephemeral);
    let item = queue.get(1).unwrap();
    assert_eq!(
        (item.kind.as_str(), item.requester_name.as_str()),
        ("song", "user5")
    );
    assert!(item.context.is_some());

    run(&reg, "request", "5", &[("text", s("再來一首"))]).await;
    let full = run(&reg, "request", "5", &[("text", s("第三首"))]).await;
    assert!(
        full.ephemeral && full.text.contains("先等等"),
        "{}",
        full.text
    );
    let empty = run(&reg, "request", "6", &[("text", s("  "))]).await;
    assert!(empty.text.contains("內容"));

    let list = run(&reg, "queue list", "6", &[]).await;
    assert!(list.ephemeral);
    assert!(
        list.text.contains("#1 [song] user5:唱一首歌"),
        "{}",
        list.text
    );
    assert!(list.text.contains("#2 [chat]"), "{}", list.text);

    // Next / done / skip default to the active item.
    let next = run(&reg, "queue next", "1", &[]).await;
    assert!(next.text.contains("輪到 #1"), "{}", next.text);
    let list = run(&reg, "queue list", "6", &[]).await;
    assert!(list.text.contains("進行中 #1"), "{}", list.text);
    assert!(
        run(&reg, "queue done", "1", &[])
            .await
            .text
            .contains("#1 完成")
    );
    assert!(
        run(&reg, "queue done", "1", &[])
            .await
            .text
            .contains("要指定編號")
    );
    let skipped = run(&reg, "queue skip", "1", &[("id", ArgValue::Integer(2))]).await;
    assert!(skipped.text.contains("跳過 #2"), "{}", skipped.text);
    let missing = run(&reg, "queue remove", "1", &[("id", ArgValue::Integer(2))]).await;
    assert!(
        missing.text.contains("找不到 #2") || missing.text.contains("不能"),
        "{}",
        missing.text
    );

    run(&reg, "request", "7", &[("text", s("a"))]).await;
    run(&reg, "request", "8", &[("text", s("b"))]).await;
    let rm = run(&reg, "queue remove", "1", &[("id", ArgValue::Integer(3))]).await;
    assert!(rm.text.contains("移除 #3"));
    let pr = run(
        &reg,
        "queue priority",
        "1",
        &[
            ("id", ArgValue::Integer(4)),
            ("priority", ArgValue::Integer(9)),
        ],
    )
    .await;
    assert!(pr.text.contains("#4 優先度設成 9"), "{}", pr.text);
    assert_eq!(queue.get(4).unwrap().priority, 9);

    let up = run(&reg, "queue upvote", "9", &[("id", ArgValue::Integer(4))]).await;
    assert!(up.text.contains("1 票"), "{}", up.text);

    assert!(
        run(&reg, "queue pause", "1", &[])
            .await
            .text
            .contains("暫停")
    );
    assert!(queue.is_paused());
    assert!(
        run(&reg, "queue next", "1", &[])
            .await
            .text
            .contains("暫停中")
    );
    let list = run(&reg, "queue list", "1", &[]).await;
    assert!(list.text.starts_with("佇列(暫停中)"), "{}", list.text);
    assert!(
        run(&reg, "queue resume", "1", &[])
            .await
            .text
            .contains("繼續")
    );
    assert!(!queue.is_paused());

    assert!(
        run(&reg, "queue clear", "1", &[])
            .await
            .text
            .contains("清掉 1 個")
    );
    assert!(
        run(&reg, "queue list", "1", &[])
            .await
            .text
            .contains("空的")
    );
}

#[tokio::test]
async fn vote_commands() {
    let (queue, reg) = setup(QueueConfig::default());

    assert!(
        run(&reg, "vote", "5", &[("option", s("左"))])
            .await
            .text
            .contains("沒有在投票")
    );
    let started = run(
        &reg,
        "queue vote start",
        "1",
        &[
            ("options", s("左, 右，上")),
            ("seconds", ArgValue::Integer(30)),
        ],
    )
    .await;
    assert!(!started.ephemeral);
    assert!(
        started.text.contains("30 秒") && started.text.contains("1. 左 / 2. 右 / 3. 上"),
        "{}",
        started.text
    );
    let again = run(
        &reg,
        "queue vote start",
        "1",
        &[("options", s("a,b")), ("seconds", ArgValue::Integer(30))],
    )
    .await;
    assert!(again.text.contains("已經有投票"));

    let list = run(&reg, "queue list", "5", &[]).await;
    assert!(
        list.text.contains("投票中:左 0 / 右 0 / 上 0"),
        "{}",
        list.text
    );

    assert!(
        run(&reg, "vote", "5", &[("option", s("右"))])
            .await
            .text
            .contains("投給「右」")
    );
    assert!(
        run(&reg, "vote", "6", &[("option", s("3"))])
            .await
            .text
            .contains("投給「上」")
    );
    assert!(
        run(&reg, "vote", "5", &[("option", s("上"))])
            .await
            .text
            .contains("投給「上」")
    );
    assert!(
        run(&reg, "vote", "7", &[("option", s("下"))])
            .await
            .text
            .contains("沒有「下」")
    );
    assert_eq!(queue.vote_status().unwrap().tallies(), [0, 0, 2]);

    let end = run(&reg, "queue vote end", "1", &[]).await;
    assert!(
        end.text.contains("贏的是「上」") && end.text.contains("上 2 票"),
        "{}",
        end.text
    );
    let bad = run(
        &reg,
        "queue vote start",
        "1",
        &[("options", s("only")), ("seconds", ArgValue::Integer(30))],
    )
    .await;
    assert!(bad.text.contains("投票設定不對"));
    let neg = run(
        &reg,
        "queue vote start",
        "1",
        &[("options", s("a,b")), ("seconds", ArgValue::Integer(-3))],
    )
    .await;
    assert!(neg.text.contains("秒數"));

    // The winner is waiting in the queue.
    let list = run(&reg, "queue list", "1", &[]).await;
    assert!(
        list.text.contains("[vote]") && list.text.contains("上"),
        "{}",
        list.text
    );
}

#[tokio::test]
async fn configurable_permissions() {
    let (queue, reg) = setup(QueueConfig {
        permissions: QueuePermissions {
            manage: "admin.queue.manage".into(),
            ..QueuePermissions::default()
        },
        ..QueueConfig::default()
    });
    run(&reg, "request", "5", &[("text", s("x"))]).await;
    for (path, args) in [
        ("queue clear", vec![]),
        ("queue pause", vec![]),
        ("queue skip", vec![("id", ArgValue::Integer(1))]),
        (
            "queue vote start",
            vec![("options", s("a,b")), ("seconds", ArgValue::Integer(9))],
        ),
    ] {
        let denied = run(&reg, path, "5", &args).await;
        assert!(
            denied.ephemeral && denied.text.contains("權限"),
            "{path}: {}",
            denied.text
        );
    }
    assert!(!queue.is_paused() && queue.list().len() == 1 && queue.vote_status().is_none());
    // Viewers may still request and vote; an owner may manage.
    assert!(run(&reg, "queue list", "5", &[]).await.text.contains("#1"));
    assert!(
        run(&reg, "queue clear", "1", &[])
            .await
            .text
            .contains("清掉 1 個")
    );
}

#[test]
fn command_paths_are_valid_and_nonconflicting() {
    let (_, reg) = setup(QueueConfig::default());
    let names: Vec<String> = reg.specs().iter().map(|s| s.name()).collect();
    for expected in [
        "request",
        "vote",
        "queue list",
        "queue next",
        "queue done",
        "queue skip",
        "queue remove",
        "queue clear",
        "queue pause",
        "queue resume",
        "queue priority",
        "queue upvote",
        "queue vote start",
        "queue vote end",
    ] {
        assert!(names.contains(&expected.to_owned()), "{expected}");
    }
}

#[tokio::test]
async fn module_wires_commands_events_and_persistence() {
    let services = Arc::new(ServiceRegistry::new());
    let store = Store::memory();
    services.provide::<dyn SettingsStore>(&ModuleId::from("app"), store.settings.clone());
    let bus = EventBus::default();
    let sup = Supervisor::new(bus.clone(), services.clone());
    sup.register(
        Arc::new(CommandsModule::new()),
        serde_json::json!({ "owners": ["discord:1"] }),
        true,
    )
    .await;
    sup.register(
        Arc::new(QueueModule::new()),
        serde_json::json!({ "persist_debounce_ms": 30, "tick_ms": 10 }),
        true,
    )
    .await;
    let mut sub = bus.subscribe(TopicFilter::new(["queue.*"]));
    sup.start_all().await.unwrap();

    let registry = services.require::<CommandRegistry>().unwrap();
    let queue = services.require::<RequestQueue>().unwrap();
    let reply = run(
        &registry,
        "request",
        "5",
        &[("text", s("挖鑽石")), ("kind", s("game_goal"))],
    )
    .await;
    assert!(reply.text.contains("#1"));

    let env = sub.recv().await.unwrap();
    assert_eq!(env.source.as_str(), "queue");
    match &env.event {
        Event::Custom { topic, payload } => {
            assert_eq!(topic, "queue.changed");
            assert_eq!(payload["items"][0]["kind"], "game_goal");
        }
        other => panic!("unexpected {other:?}"),
    }
    queue.next().unwrap();
    let mut saw_activation = false;
    for _ in 0..2 {
        let env = sub.recv().await.unwrap();
        saw_activation |= env.topic() == "queue.item_activated";
    }
    assert!(saw_activation);

    // Restarting the module keeps the queue (snapshot restore) and the commands.
    sup.restart(&ModuleId::from("queue")).await.unwrap();
    let revived = services.require::<RequestQueue>().unwrap();
    assert!(!Arc::ptr_eq(&queue, &revived));
    assert_eq!(revived.current().unwrap().text, "挖鑽石");
    let registry = services.require::<CommandRegistry>().unwrap();
    assert!(
        run(&registry, "queue list", "5", &[])
            .await
            .text
            .contains("進行中 #1")
    );

    // Disabling it removes the commands again.
    sup.disable(&ModuleId::from("queue")).await.unwrap();
    assert!(services.get::<RequestQueue>().is_none());
    assert!(registry.get(&["request".to_owned()]).is_none());
    let snapshot = store
        .settings
        .get(&ProfileId::from("_global"), "queue:state")
        .await
        .unwrap();
    assert!(snapshot.is_some());
    sup.stop_all().await;
}
