//! `game start | stop | goal | status`.

use std::time::Duration;

use miyoria_commands::{ArgKind, ArgSpec, CommandRegistry, CommandReply, CommandSpec};
use tokio::sync::{mpsc, oneshot};

use crate::config::GamePermissions;
use crate::director::{Control, GameStatus, Placement, View};

const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

async fn ask(
    tx: &mpsc::UnboundedSender<Control>,
    make: impl FnOnce(oneshot::Sender<Result<String, String>>) -> Control,
) -> CommandReply {
    let (reply, rx) = oneshot::channel();
    if tx.send(make(reply)).is_err() {
        return CommandReply::ephemeral("遊戲模組沒在跑。");
    }
    match tokio::time::timeout(REPLY_TIMEOUT, rx).await {
        Ok(Ok(Ok(text))) => CommandReply::public(text),
        Ok(Ok(Err(text))) => CommandReply::ephemeral(text),
        _ => CommandReply::ephemeral("遊戲模組沒有回應。"),
    }
}

/// `game status` text.
pub fn format_status(status: Option<&GameStatus>) -> String {
    let Some(s) = status else {
        return "現在沒在玩遊戲。".to_owned();
    };
    let mut out = format!("正在玩 {}(實況送到 {})", s.game_name, s.context);
    match &s.goal {
        Some(g) => {
            out.push_str(&format!(
                "\n目標:{}{}(已 {} 秒)",
                g.text, g.note, g.age_secs
            ));
            if let Some(a) = &g.action {
                out.push_str(&format!("\n動作:{a}"));
            }
        }
        None => out.push_str("\n目標:還沒決定"),
    }
    if !s.backlog.is_empty() {
        out.push_str(&format!("\n排隊中:{}", s.backlog.join("、")));
    }
    if let Some(busy) = s.busy {
        out.push_str(if busy {
            "\nbot:忙碌中"
        } else {
            "\nbot:閒置"
        });
    }
    if !s.summary.is_empty() {
        let short: String = s.summary.lines().take(4).collect::<Vec<_>>().join(" / ");
        out.push_str(&format!("\n狀況:{short}"));
    }
    out
}

/// Registers the commands; returns their paths for unregistering.
pub(crate) fn register(
    registry: &CommandRegistry,
    perms: &GamePermissions,
    default_game: &str,
    tx: mpsc::UnboundedSender<Control>,
    view: View,
) -> anyhow::Result<Vec<String>> {
    registry.set_group_description("game", "遊戲直播");
    let mut paths = Vec::new();

    let spec = CommandSpec::new("game start", "開始玩遊戲(慢迴路導演 + 實況)")
        .arg(
            ArgSpec::new(
                "game",
                format!("遊戲 id,預設 {default_game}"),
                ArgKind::String,
            )
            .optional(),
        )
        .arg(
            ArgSpec::new(
                "where",
                "實況送到哪裡:auto(預設,語音頻道 > 直播頻道 > 這裡)、voice、here、stream",
                ArgKind::Choice(
                    ["auto", "voice", "here", "stream"]
                        .map(String::from)
                        .to_vec(),
                ),
            )
            .optional(),
        )
        .permission(&perms.start);
    paths.push(spec.name());
    let default_game = default_game.to_owned();
    let start_tx = tx.clone();
    registry.register(spec, move |inv| {
        let tx = start_tx.clone();
        let game = inv
            .str("game")
            .map(|g| g.trim().to_lowercase())
            .filter(|g| !g.is_empty())
            .unwrap_or_else(|| default_game.clone());
        let placement = match inv.str("where") {
            Some("voice") => Placement::Voice,
            Some("here") => Placement::Here,
            Some("stream") => Placement::Stream,
            _ => Placement::Auto,
        };
        async move {
            Ok(ask(&tx, |reply| Control::Start {
                game,
                placement,
                here: inv.context.clone(),
                invoker: inv.invoker.clone(),
                reply,
            })
            .await)
        }
    })?;

    let spec = CommandSpec::new("game stop", "停止玩遊戲").permission(&perms.stop);
    paths.push(spec.name());
    let stop_tx = tx.clone();
    registry.register(spec, move |_| {
        let tx = stop_tx.clone();
        async move { Ok(ask(&tx, |reply| Control::Stop { reply }).await) }
    })?;

    let spec = CommandSpec::new("game goal", "指定她接下來在遊戲裡要做的事")
        .arg(ArgSpec::new(
            "text",
            "目標,例如「去挖鐵礦」",
            ArgKind::String,
        ))
        .permission(&perms.goal);
    paths.push(spec.name());
    registry.register(spec, move |inv| {
        let tx = tx.clone();
        let text = inv.str("text").unwrap_or_default().to_owned();
        let by = inv.invoker_display_name.clone();
        async move { Ok(ask(&tx, |reply| Control::Goal { text, by, reply }).await) }
    })?;

    let spec = CommandSpec::new("game status", "看她現在在玩什麼、目標是什麼")
        .permission(&perms.status)
        .ephemeral(true);
    paths.push(spec.name());
    registry.register(spec, move |_| {
        let text = format_status(view.lock().as_ref());
        async move { Ok(CommandReply::ephemeral(text)) }
    })?;
    Ok(paths)
}
