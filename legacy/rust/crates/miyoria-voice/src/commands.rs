//! `join`, `leave` and `voice consent` commands.

use std::sync::Arc;

use miyoria_commands::{ArgKind, ArgSpec, CommandRegistry, CommandReply, CommandSpec, Invocation};
use tracing::warn;

use crate::consent::{Consent, ConsentPolicy};
use crate::link::VoiceLink;

/// Paths registered by [`register`].
pub const PATHS: &[&str] = &["join", "leave", "voice consent"];

/// The announcement she makes after joining a voice channel.
pub fn join_announcement(policy: ConsentPolicy) -> String {
    match policy {
        ConsentPolicy::OptOut => "哼,我進來了。先說好,我會聽你們講話喔……\
            不想被我聽到的話就用 `/voice consent off`,我、我才不會在意呢!"
            .to_owned(),
        ConsentPolicy::OptIn => "哼,我進來了。想讓我聽到你說話的話,要先用 \
            `/voice consent on` 喔……不、不是我想聽啦!(`/voice consent off` 可以隨時取消)"
            .to_owned(),
    }
}

fn guild_of(inv: &Invocation) -> Option<&str> {
    inv.context.scope.as_deref()
}

/// Registers the voice commands. Undo with [`unregister`].
pub fn register(
    registry: &CommandRegistry,
    link: Arc<VoiceLink>,
    consent: Arc<Consent>,
) -> anyhow::Result<()> {
    registry.set_group_description("voice", "語音設定");

    let join_link = link.clone();
    let policy = consent.policy();
    registry.register(
        CommandSpec::new("join", "叫她進你現在所在的語音頻道").permission("voice.join"),
        move |inv: Invocation| {
            let link = join_link.clone();
            async move {
                let Some(guild) = guild_of(&inv) else {
                    return Ok(CommandReply::ephemeral(
                        "要在伺服器裡叫我啦,私訊是要我進哪裡?",
                    ));
                };
                let same_platform = link
                    .self_account()
                    .is_some_and(|a| a.platform == inv.invoker.platform);
                if !link.is_connected() || !same_platform {
                    return Ok(CommandReply::ephemeral(
                        "我的語音帳號現在不在線上……等一下再叫我啦。",
                    ));
                }
                match link.join(guild, None, Some(&inv.invoker.id)).await {
                    Ok(_) => Ok(CommandReply::public(join_announcement(policy))),
                    Err(e) => {
                        warn!(error = %e, %guild, "join failed");
                        Ok(CommandReply::ephemeral(format!(
                            "進不去欸……你有在語音頻道裡嗎?({e})"
                        )))
                    }
                }
            }
        },
    )?;

    let leave_link = link;
    registry.register(
        CommandSpec::new("leave", "叫她離開語音頻道").permission("voice.leave"),
        move |inv: Invocation| {
            let link = leave_link.clone();
            async move {
                let Some(guild) = guild_of(&inv) else {
                    return Ok(CommandReply::ephemeral("要在伺服器裡用啦。"));
                };
                if link.channel(guild).is_none() {
                    return Ok(CommandReply::ephemeral("我本來就不在語音裡啊。"));
                }
                link.leave(guild).await?;
                Ok(CommandReply::public("好啦好啦,我走就是了。"))
            }
        },
    )?;

    registry.register(
        CommandSpec::new("voice consent", "設定她在語音頻道裡能不能聽你說話")
            .arg(ArgSpec::new(
                "state",
                "on = 可以聽,off = 不要聽",
                ArgKind::Choice(vec!["on".to_owned(), "off".to_owned()]),
            ))
            .permission("voice.consent")
            .ephemeral(true),
        move |inv: Invocation| {
            let consent = consent.clone();
            async move {
                let allowed = inv.str("state") == Some("on");
                consent.set(&inv.invoker, allowed).await?;
                Ok(CommandReply::ephemeral(if allowed {
                    "知道了,我會聽你說話的。哼,別講無聊的事喔。"
                } else {
                    "好,我不會聽你說話了。……也不是說我很想聽啦。"
                }))
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
