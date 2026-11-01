//! `stream start | stop | scene <name> | status` commands.

use std::sync::Arc;

use miyoria_commands::{ArgKind, ArgSpec, CommandRegistry, CommandReply, CommandSpec, Invocation};
use tracing::warn;

use super::StageLink;
use crate::protocol::{StageStatus, StreamAction};

/// Paths registered by [`register`].
pub const PATHS: &[&str] = &[
    "stream start",
    "stream stop",
    "stream scene",
    "stream status",
];

const OFFLINE: &str = "直播機那邊沒連上……先把 `miyoria stage` 打開啦。";

/// One-line summary of a status.
pub fn describe(status: &StageStatus) -> String {
    let on = |b: bool| if b { "已連線" } else { "未連線" };
    format!(
        "VTube Studio:{}|OBS:{}|場景:{}|直播:{}",
        on(status.vts),
        on(status.obs),
        status.scene.as_deref().unwrap_or("—"),
        if status.streaming {
            "直播中"
        } else {
            "沒在直播"
        },
    )
}

/// Registers the stream commands. Undo with [`unregister`].
pub fn register(registry: &CommandRegistry, link: Arc<StageLink>) -> anyhow::Result<()> {
    registry.set_group_description("stream", "直播控制(OBS)");

    for (action, path, description) in [
        (StreamAction::Start, "stream start", "開始直播"),
        (StreamAction::Stop, "stream stop", "停止直播"),
    ] {
        let link = link.clone();
        let permission = format!("stream.{}", path.trim_start_matches("stream "));
        registry.register(
            CommandSpec::new(path, description).permission(permission),
            move |_inv: Invocation| {
                let link = link.clone();
                async move {
                    if !link.is_connected() {
                        return Ok(CommandReply::ephemeral(OFFLINE));
                    }
                    Ok(match link.stream(action).await {
                        Ok(status) if status.streaming == (action == StreamAction::Start) => {
                            CommandReply::public(match action {
                                StreamAction::Start => "開台了!……才、才不是因為想見大家呢。",
                                StreamAction::Stop => "收台了。今天就到這裡,哼。",
                            })
                        }
                        Ok(status) => CommandReply::ephemeral(format!(
                            "指令送出去了,不過 OBS 好像還沒反應過來。({})",
                            describe(&status)
                        )),
                        Err(e) => {
                            warn!(error = %e, ?action, "stream command failed");
                            CommandReply::ephemeral(format!("OBS 不聽話……({e})"))
                        }
                    })
                }
            },
        )?;
    }

    let scene_link = link.clone();
    registry.register(
        CommandSpec::new("stream scene", "切換 OBS 場景")
            .arg(ArgSpec::new("name", "場景名稱", ArgKind::String))
            .permission("stream.scene"),
        move |inv: Invocation| {
            let link = scene_link.clone();
            async move {
                if !link.is_connected() {
                    return Ok(CommandReply::ephemeral(OFFLINE));
                }
                let name = inv.str("name").unwrap_or_default().trim().to_owned();
                if name.is_empty() {
                    return Ok(CommandReply::ephemeral("要切到哪個場景啦?"));
                }
                Ok(match link.set_scene(&name).await {
                    Ok(_) => CommandReply::public(format!("切到「{name}」了。")),
                    Err(e) => {
                        warn!(error = %e, %name, "scene switch failed");
                        CommandReply::ephemeral(format!("切不過去欸……({e})"))
                    }
                })
            }
        },
    )?;

    registry.register(
        CommandSpec::new("stream status", "看直播機的狀態")
            .permission("stream.status")
            .ephemeral(true),
        move |_inv: Invocation| {
            let link = link.clone();
            async move {
                if !link.is_connected() {
                    return Ok(CommandReply::ephemeral(OFFLINE));
                }
                let status = match link.refresh_status().await {
                    Ok(status) => status,
                    Err(e) => {
                        warn!(error = %e, "status request failed");
                        link.status().unwrap_or_default()
                    }
                };
                Ok(CommandReply::ephemeral(describe(&status)))
            }
        },
    )?;
    Ok(())
}

pub fn unregister(registry: &CommandRegistry) {
    for path in PATHS {
        registry.unregister(path);
    }
}
