//! Agent commands (`mode`, `activeness`, `persona show`), registered in the
//! `commands` module's registry when it is available.

use std::sync::Arc;

use miyoria_commands::{ArgKind, ArgSpec, CommandRegistry, CommandReply, CommandSpec, Invocation};
use miyoria_kernel::ServiceRegistry;
use parking_lot::Mutex;
use tracing::{debug, warn};

use crate::config::{Activeness, ChannelMode};
use crate::handle::AgentHandle;
use crate::persona::PersonaHandle;

pub(crate) const PATHS: [&str; 3] = ["mode", "activeness", "persona show"];
const NOT_SAVED: &str = "\n(不過沒存起來……重開之後我就會忘記喔。)";

/// Remembers which registry the commands went into, so they can be removed
/// on stop and re-registered when the `commands` module restarts.
#[derive(Default)]
pub(crate) struct AgentCommands {
    installed: Mutex<Option<Arc<CommandRegistry>>>,
}

impl AgentCommands {
    /// Registers the commands in the current `CommandRegistry` service, if any.
    pub fn install(
        &self,
        services: &ServiceRegistry,
        handle: Arc<AgentHandle>,
        persona: PersonaHandle,
    ) {
        let Some(registry) = services.get::<CommandRegistry>() else {
            debug!("no command registry, agent commands not registered");
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
        match register(&registry, handle, persona) {
            Ok(()) => *installed = Some(registry),
            Err(e) => {
                warn!(error = %format!("{e:#}"), "could not register agent commands");
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

fn register(
    registry: &CommandRegistry,
    handle: Arc<AgentHandle>,
    persona: PersonaHandle,
) -> anyhow::Result<()> {
    let h = handle.clone();
    registry.register(
        CommandSpec::new("mode", "查看或設定這個頻道的聊天模式")
            .arg(
                ArgSpec::new(
                    "mode",
                    "off / mention-only / ambient / always / reset(恢復預設)",
                    ArgKind::Choice(choices(&[
                        "off",
                        "mention-only",
                        "ambient",
                        "always",
                        "reset",
                    ])),
                )
                .optional(),
            )
            .permission("admin.channel.mode"),
        move |inv: Invocation| {
            let h = h.clone();
            async move { Ok(mode(&h, &inv).await) }
        },
    )?;

    let h = handle;
    registry.register(
        CommandSpec::new("activeness", "查看或設定我在這個頻道主動插話的程度")
            .arg(
                ArgSpec::new(
                    "level",
                    "low / medium / high / reset(恢復預設)",
                    ArgKind::Choice(choices(&["low", "medium", "high", "reset"])),
                )
                .optional(),
            )
            .permission("admin.channel.activeness"),
        move |inv: Invocation| {
            let h = h.clone();
            async move { Ok(activeness(&h, &inv).await) }
        },
    )?;

    registry.set_group_description("persona", "人格設定");
    registry.register(
        CommandSpec::new("persona show", "列出人格段落與字數")
            .permission("admin.persona.view")
            .ephemeral(true),
        move |_| {
            let persona = persona.clone();
            async move { Ok(CommandReply::ephemeral(persona_summary(&persona))) }
        },
    )?;
    Ok(())
}

fn choices(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).to_owned()).collect()
}

fn mode_label(mode: ChannelMode) -> &'static str {
    match mode {
        ChannelMode::Off => "完全不說話",
        ChannelMode::MentionOnly => "被叫到才回",
        ChannelMode::Ambient => "會自己插話",
        ChannelMode::Always => "每句都回",
    }
}

fn activeness_label(level: Activeness) -> &'static str {
    match level {
        Activeness::Low => "低",
        Activeness::Medium => "普通",
        Activeness::High => "高",
    }
}

async fn mode(handle: &AgentHandle, inv: &Invocation) -> CommandReply {
    let ctx = &inv.context;
    let reply = match inv.str("mode") {
        None => {
            let current = handle.channel_mode(ctx);
            let source = if handle.channel_mode_override(ctx).is_some() {
                "有人特別設定的"
            } else {
                "預設"
            };
            format!("這裡現在是 `{current}`({}),{source}。", mode_label(current))
        }
        Some("reset") => {
            let saved = handle.set_channel_mode(ctx, None).await;
            let current = handle.channel_mode(ctx);
            with_save_note(
                format!("好啦,恢復成預設的 `{current}`({})了。", mode_label(current)),
                saved,
            )
        }
        Some(value) => match value.parse::<ChannelMode>() {
            Ok(mode) => {
                let saved = handle.set_channel_mode(ctx, Some(mode)).await;
                let line = match mode {
                    ChannelMode::Off => "……好啦,我在這裡閉嘴就是了。哼。".to_owned(),
                    _ => format!(
                        "知道了,這裡改成 `{mode}`({})。才不是因為你叫我才改的喔。",
                        mode_label(mode)
                    ),
                };
                with_save_note(line, saved)
            }
            Err(_) => format!("`{value}` 是什麼模式啦?"),
        },
    };
    CommandReply::public(reply)
}

async fn activeness(handle: &AgentHandle, inv: &Invocation) -> CommandReply {
    let ctx = &inv.context;
    let reply = match inv.str("level") {
        None => {
            let current = handle.activeness(ctx);
            let source = if handle.activeness_override(ctx).is_some() {
                "有人特別設定的"
            } else {
                "預設"
            };
            format!(
                "我在這裡的主動程度是 `{current}`({}),{source}。",
                activeness_label(current)
            )
        }
        Some("reset") => {
            let saved = handle.set_activeness(ctx, None).await;
            let current = handle.activeness(ctx);
            with_save_note(
                format!(
                    "好啦,恢復成預設的 `{current}`({})了。",
                    activeness_label(current)
                ),
                saved,
            )
        }
        Some(value) => match value.parse::<Activeness>() {
            Ok(level) => {
                let saved = handle.set_activeness(ctx, Some(level)).await;
                let line = match level {
                    Activeness::Low => "好啦,我少講一點。反正我也沒很想跟你們聊。",
                    Activeness::Medium => "知道了,照平常那樣。",
                    Activeness::High => "要我多說話?哼……既然你們這麼想聽,那就勉強陪你們吧。",
                };
                with_save_note(line.to_owned(), saved)
            }
            Err(_) => format!("`{value}` 是什麼程度啦?"),
        },
    };
    CommandReply::public(reply)
}

fn with_save_note(mut text: String, saved: anyhow::Result<()>) -> String {
    if let Err(e) = saved {
        warn!(error = %format!("{e:#}"), "could not persist agent setting");
        text.push_str(NOT_SAVED);
    }
    text
}

fn persona_summary(persona: &PersonaHandle) -> String {
    persona.read(|p| {
        let mut out = format!("`{}` 的人格段落:", p.id);
        if p.sections.is_empty() {
            out.push_str("\n(沒有)");
        }
        for s in &p.sections {
            out.push_str(&format!("\n`{}`:{} 字", s.key, s.body.chars().count()));
        }
        if !p.examples.is_empty() {
            out.push_str(&format!("\n範例對話:{} 則", p.examples.len()));
        }
        out
    })
}
