use std::sync::Arc;
use std::time::Duration;

use miyoria_commands::{ArgKind, ArgSpec, CommandRegistry, CommandReply, CommandSpec, Invocation};

use crate::queue::RequestQueue;
use crate::types::{ItemId, QueueError, QueueItem, SubmitRequest, VoteResult};

const LIST_LIMIT: usize = 10;

type Handler = dyn Fn(&RequestQueue, Invocation) -> CommandReply + Send + Sync;

/// Registers `request`, `vote`, `queue list | next | done | skip | remove |
/// clear | pause | resume | priority | upvote` and `queue vote start | end`.
/// Returns the registered paths (for unregistering).
///
/// `vote <option>` is a top-level command, so starting a vote lives under
/// `queue vote start` (a command path cannot be the prefix of another).
pub fn register_commands(
    registry: &CommandRegistry,
    queue: &Arc<RequestQueue>,
) -> anyhow::Result<Vec<String>> {
    let perms = queue.config().permissions.clone();
    let mut paths = Vec::new();
    let mut add = |spec: CommandSpec, handler: Box<Handler>| -> anyhow::Result<()> {
        paths.push(spec.name());
        let queue = queue.clone();
        let handler: Arc<Handler> = handler.into();
        registry.register(spec, move |inv| {
            let reply = handler(&queue, inv);
            async move { Ok(reply) }
        })
    };

    registry.set_group_description("queue", "請求佇列");
    registry.set_group_description("queue vote", "投票模式");

    add(
        CommandSpec::new("request", "排一個請求")
            .arg(ArgSpec::new("text", "想要的內容", ArgKind::String))
            .arg(ArgSpec::new("kind", "種類,例如 song、game_goal", ArgKind::String).optional())
            .permission(&perms.request),
        Box::new(|q, inv| {
            let mut req = SubmitRequest::new(
                inv.invoker.clone(),
                inv.invoker_display_name.clone(),
                inv.str("kind").unwrap_or_default(),
                inv.str("text").unwrap_or_default(),
            );
            req.context = Some(inv.context.clone());
            match q.submit(req) {
                Ok(s) => {
                    CommandReply::public(format!("收到啦,#{} 排第 {} 個。", s.item.id, s.position))
                }
                Err(e) => CommandReply::ephemeral(error_text(&e)),
            }
        }),
    )?;

    add(
        CommandSpec::new("queue list", "看目前的佇列")
            .permission("queue.list")
            .ephemeral(true),
        Box::new(|q, _| CommandReply::ephemeral(format_list(q))),
    )?;

    add(
        CommandSpec::new("queue next", "叫下一個")
            .permission(&perms.manage)
            .ephemeral(true),
        Box::new(|q, _| match q.next() {
            Some(item) => CommandReply::public(format!("輪到 {}", describe(&item))),
            None if q.is_paused() => CommandReply::ephemeral("暫停中,不叫人。"),
            None => CommandReply::ephemeral("沒有人在排隊。"),
        }),
    )?;

    add(
        CommandSpec::new("queue done", "標記進行中的項目完成")
            .arg(ArgSpec::new("id", "項目編號,預設目前進行中的", ArgKind::Integer).optional())
            .permission(&perms.manage)
            .ephemeral(true),
        Box::new(|q, inv| {
            let Some(id) = target_id(q, &inv) else {
                return CommandReply::ephemeral("要指定編號,或是現在要有進行中的項目。");
            };
            match id.and_then(|id| q.complete(id)) {
                Ok(item) => CommandReply::ephemeral(format!("#{} 完成了。", item.id)),
                Err(e) => CommandReply::ephemeral(error_text(&e)),
            }
        }),
    )?;

    add(
        CommandSpec::new("queue skip", "跳過項目")
            .arg(ArgSpec::new("id", "項目編號,預設目前進行中的", ArgKind::Integer).optional())
            .permission(&perms.manage)
            .ephemeral(true),
        Box::new(|q, inv| {
            let Some(id) = target_id(q, &inv) else {
                return CommandReply::ephemeral("要指定編號,或是現在要有進行中的項目。");
            };
            match id.and_then(|id| q.skip(id)) {
                Ok(item) => CommandReply::ephemeral(format!("跳過 #{} 了。", item.id)),
                Err(e) => CommandReply::ephemeral(error_text(&e)),
            }
        }),
    )?;

    add(
        CommandSpec::new("queue remove", "移除項目")
            .arg(ArgSpec::new("id", "項目編號", ArgKind::Integer))
            .permission(&perms.manage)
            .ephemeral(true),
        Box::new(|q, inv| match item_id(&inv).and_then(|id| q.remove(id)) {
            Ok(item) => CommandReply::ephemeral(format!("移除 #{} 了。", item.id)),
            Err(e) => CommandReply::ephemeral(error_text(&e)),
        }),
    )?;

    add(
        CommandSpec::new("queue clear", "清空排隊中的項目")
            .permission(&perms.manage)
            .ephemeral(true),
        Box::new(|q, _| CommandReply::ephemeral(format!("清掉 {} 個。", q.clear()))),
    )?;

    add(
        CommandSpec::new("queue pause", "暫停叫號")
            .permission(&perms.manage)
            .ephemeral(true),
        Box::new(|q, _| {
            q.pause();
            CommandReply::ephemeral("暫停了,還是可以排,但不會叫下一個。")
        }),
    )?;

    add(
        CommandSpec::new("queue resume", "恢復叫號")
            .permission(&perms.manage)
            .ephemeral(true),
        Box::new(|q, _| {
            q.resume();
            CommandReply::ephemeral("繼續囉。")
        }),
    )?;

    add(
        CommandSpec::new("queue priority", "設定項目優先度(越大越前面)")
            .arg(ArgSpec::new("id", "項目編號", ArgKind::Integer))
            .arg(ArgSpec::new("priority", "優先度整數", ArgKind::Integer))
            .permission(&perms.manage)
            .ephemeral(true),
        Box::new(|q, inv| {
            let priority = inv.int("priority").and_then(|p| i32::try_from(p).ok());
            let (Ok(id), Some(priority)) = (item_id(&inv), priority) else {
                return CommandReply::ephemeral("編號或優先度不對。");
            };
            match q.set_priority(id, priority) {
                Ok(()) => CommandReply::ephemeral(format!("#{id} 優先度設成 {priority}。")),
                Err(e) => CommandReply::ephemeral(error_text(&e)),
            }
        }),
    )?;

    add(
        CommandSpec::new("queue upvote", "幫排隊中的項目加一票")
            .arg(ArgSpec::new("id", "項目編號", ArgKind::Integer))
            .permission(&perms.vote)
            .ephemeral(true),
        Box::new(
            |q, inv| match item_id(&inv).and_then(|id| q.vote(id, &inv.invoker)) {
                Ok(n) => CommandReply::ephemeral(format!("加票了,現在 {n} 票。")),
                Err(e) => CommandReply::ephemeral(error_text(&e)),
            },
        ),
    )?;

    add(
        CommandSpec::new("queue vote start", "開始投票")
            .arg(ArgSpec::new("options", "選項,用逗號分隔", ArgKind::String))
            .arg(ArgSpec::new("seconds", "投票秒數", ArgKind::Integer))
            .permission(&perms.manage),
        Box::new(|q, inv| {
            let options: Vec<String> = inv
                .str("options")
                .unwrap_or_default()
                .split([',', '，', '、'])
                .map(|s| s.trim().to_owned())
                .collect();
            let seconds = inv.int("seconds").and_then(|s| u64::try_from(s).ok());
            let Some(seconds) = seconds else {
                return CommandReply::ephemeral("秒數要是正整數。");
            };
            match q.start_vote(options, Duration::from_secs(seconds)) {
                Ok(()) => {
                    let vote = q.vote_status().expect("vote just started");
                    let list = vote
                        .options
                        .iter()
                        .enumerate()
                        .map(|(i, o)| format!("{}. {o}", i + 1))
                        .collect::<Vec<_>>()
                        .join(" / ");
                    CommandReply::public(format!(
                        "投票開始!{seconds} 秒內用 `vote <選項>` 投:{list}"
                    ))
                }
                Err(e) => CommandReply::ephemeral(error_text(&e)),
            }
        }),
    )?;

    add(
        CommandSpec::new("queue vote end", "提前結束投票").permission(&perms.manage),
        Box::new(|q, _| match q.end_vote() {
            Ok(result) => CommandReply::public(format_result(&result)),
            Err(e) => CommandReply::ephemeral(error_text(&e)),
        }),
    )?;

    add(
        CommandSpec::new("vote", "投票")
            .arg(ArgSpec::new("option", "選項文字或編號", ArgKind::String))
            .permission(&perms.vote)
            .ephemeral(true),
        Box::new(
            |q, inv| match q.cast_vote(&inv.invoker, inv.str("option").unwrap_or_default()) {
                Ok(option) => CommandReply::ephemeral(format!("投給「{option}」了。")),
                Err(e) => CommandReply::ephemeral(error_text(&e)),
            },
        ),
    )?;

    Ok(paths)
}

/// Required `id` argument. Negative numbers are treated as unknown items.
fn item_id(inv: &Invocation) -> Result<ItemId, QueueError> {
    let raw = inv.int("id").unwrap_or_default();
    ItemId::try_from(raw).map_err(|_| QueueError::NotFound(0))
}

/// Optional `id`, defaulting to the current active item. `None` when neither exists.
fn target_id(q: &RequestQueue, inv: &Invocation) -> Option<Result<ItemId, QueueError>> {
    if inv.args.contains_key("id") {
        Some(item_id(inv))
    } else {
        q.current().map(|item| Ok(item.id))
    }
}

fn describe(item: &QueueItem) -> String {
    let text: String = item.text.chars().take(30).collect();
    let ellipsis = if item.text.chars().count() > 30 {
        "…"
    } else {
        ""
    };
    format!(
        "#{} [{}] {}:{text}{ellipsis}",
        item.id, item.kind, item.requester_name
    )
}

fn format_list(q: &RequestQueue) -> String {
    let items = q.list();
    let mut out = String::from(if q.is_paused() {
        "佇列(暫停中)"
    } else {
        "佇列"
    });
    if items.is_empty() {
        out.push_str(":空的。");
    }
    for item in items.iter().take(LIST_LIMIT) {
        let place = match item.state {
            crate::types::ItemState::Active => "進行中".to_owned(),
            _ => "排隊".to_owned(),
        };
        out.push_str(&format!("\n{place} {}", describe(item)));
        if item.votes > 0 {
            out.push_str(&format!(" ({}票)", item.votes));
        }
    }
    if items.len() > LIST_LIMIT {
        out.push_str(&format!("\n……還有 {} 個", items.len() - LIST_LIMIT));
    }
    if let Some(vote) = q.vote_status() {
        let tallies = vote.tallies();
        let line = vote
            .options
            .iter()
            .zip(tallies)
            .map(|(o, n)| format!("{o} {n}"))
            .collect::<Vec<_>>()
            .join(" / ");
        out.push_str(&format!("\n投票中:{line}"));
    }
    out
}

fn format_result(result: &VoteResult) -> String {
    let line = result
        .options
        .iter()
        .zip(&result.tallies)
        .map(|(o, n)| format!("{o} {n} 票"))
        .collect::<Vec<_>>()
        .join(" / ");
    match result.winner_option() {
        Some(winner) => format!("投票結束:{line}。贏的是「{winner}」。"),
        None => format!("投票結束:{line}。沒有人投,算了。"),
    }
}

/// User-facing (Traditional Chinese) text of a queue error.
pub fn error_text(error: &QueueError) -> String {
    match error {
        QueueError::Blocked => "這個我不接。".to_owned(),
        QueueError::EmptyText => "要寫點內容啦。".to_owned(),
        QueueError::TextTooLong(n) => format!("太長了,最多 {n} 個字。"),
        QueueError::UserLimit(n) => format!("你已經排了 {n} 個了,先等等啦。"),
        QueueError::QueueFull(_) => "佇列滿了啦,晚點再來。".to_owned(),
        QueueError::NotFound(id) => format!("找不到 #{id}。"),
        QueueError::WrongState(id) => format!("#{id} 現在不能這樣處理。"),
        QueueError::VoteRunning => "已經有投票在跑了。".to_owned(),
        QueueError::NoVote => "現在沒有在投票。".to_owned(),
        QueueError::BadVote(why) => format!("投票設定不對:{why}"),
        QueueError::UnknownOption(o) => format!("沒有「{o}」這個選項。"),
    }
}
