//! Pure conversions between serenity models and Miyoria types.

use std::collections::{BTreeMap, HashSet};

use miyoria_commands::{ArgValue, ResolvedUser};
use miyoria_types::{
    AccountRef, Attachment, Author, ContextKey, ContextKind, IncomingMessage, MessageRef,
    PlatformId,
};
use serenity::all::{
    ChannelType, CommandDataOption, CommandDataOptionValue, CommandDataResolved, GuildId, Member,
    Message, Permissions, RoleId, User, UserId,
};

pub const PLATFORM: &str = "discord";

pub fn platform() -> PlatformId {
    PlatformId::new(PLATFORM)
}

pub fn account(user: UserId) -> AccountRef {
    AccountRef {
        platform: platform(),
        id: user.get().to_string(),
    }
}

pub fn context_key(guild: Option<GuildId>, channel: u64, kind: ContextKind) -> ContextKey {
    ContextKey {
        platform: platform(),
        scope: guild.map(|g| g.get().to_string()),
        channel: channel.to_string(),
        kind,
    }
}

/// Context kind of a guild channel type. Text chat in voice channels counts
/// as a normal channel; voice contexts belong to the voice node.
pub fn kind_of(channel: ChannelType) -> ContextKind {
    match channel {
        ChannelType::PublicThread | ChannelType::PrivateThread | ChannelType::NewsThread => {
            ContextKind::Thread
        }
        ChannelType::Private | ChannelType::GroupDm => ContextKind::Dm,
        _ => ContextKind::Channel,
    }
}

/// Guild nickname > global display name > username.
pub fn display_name(user: &User, nick: Option<&str>) -> String {
    nick.or(user.global_name.as_deref())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(&user.name)
        .to_owned()
}

/// Maps a gateway message. `self_ids` are all of her accounts (bot and
/// self account).
pub fn incoming_message(
    msg: &Message,
    kind: ContextKind,
    self_ids: &HashSet<UserId>,
) -> IncomingMessage {
    let kind = if msg.guild_id.is_none() {
        ContextKind::Dm
    } else {
        kind
    };
    let context = context_key(msg.guild_id, msg.channel_id.get(), kind);
    let nick = msg.member.as_ref().and_then(|m| m.nick.as_deref());
    IncomingMessage {
        id: MessageRef {
            context,
            id: msg.id.get().to_string(),
        },
        author: Author {
            account: account(msg.author.id),
            display_name: display_name(&msg.author, nick),
            is_bot: msg.author.bot,
        },
        text: msg.content.clone(),
        mentions_self: msg.mentions.iter().any(|u| self_ids.contains(&u.id)),
        reply_to_self: msg
            .referenced_message
            .as_ref()
            .is_some_and(|r| self_ids.contains(&r.author.id)),
        attachments: msg
            .attachments
            .iter()
            .map(|a| Attachment {
                url: a.url.clone(),
                filename: a.filename.clone(),
                content_type: a.content_type.clone(),
            })
            .collect(),
        ts: *msg.timestamp,
    }
}

/// Members with Administrator or Manage Server count as guild admins.
pub fn is_guild_admin(member: Option<&Member>) -> bool {
    member.and_then(|m| m.permissions).is_some_and(admin_perms)
}

fn admin_perms(p: Permissions) -> bool {
    p.contains(Permissions::ADMINISTRATOR) || p.manage_guild()
}

/// Role ids of a guild member, as strings.
pub fn role_ids(roles: &[RoleId]) -> Vec<String> {
    roles.iter().map(|r| r.get().to_string()).collect()
}

/// Guild details of the users passed in user options, keyed by user id.
/// Users without member data (e.g. in DMs) get no roles.
pub fn resolved_users(resolved: &CommandDataResolved) -> BTreeMap<String, ResolvedUser> {
    resolved
        .users
        .iter()
        .map(|(id, user)| {
            let member = resolved.members.get(id);
            let nick = member.and_then(|m| m.nick.as_deref());
            let info = ResolvedUser {
                display_name: display_name(user, nick),
                platform_roles: member.map(|m| role_ids(&m.roles)).unwrap_or_default(),
                is_guild_admin: member.and_then(|m| m.permissions).is_some_and(admin_perms),
            };
            (id.get().to_string(), info)
        })
        .collect()
}

/// Flattens an interaction into a command path and argument values.
pub fn command_path(
    name: &str,
    options: &[CommandDataOption],
) -> (Vec<String>, BTreeMap<String, ArgValue>) {
    let mut path = vec![name.to_owned()];
    let mut options = options;
    while let Some(CommandDataOption {
        name: sub,
        value:
            CommandDataOptionValue::SubCommand(inner) | CommandDataOptionValue::SubCommandGroup(inner),
        ..
    }) = options.first()
    {
        path.push(sub.clone());
        options = inner;
    }
    let args = options
        .iter()
        .filter_map(|o| arg_value(&o.value).map(|v| (o.name.clone(), v)))
        .collect();
    (path, args)
}

fn arg_value(value: &CommandDataOptionValue) -> Option<ArgValue> {
    Some(match value {
        CommandDataOptionValue::String(s) => ArgValue::String(s.clone()),
        CommandDataOptionValue::Integer(i) => ArgValue::Integer(*i),
        CommandDataOptionValue::Boolean(b) => ArgValue::Boolean(*b),
        CommandDataOptionValue::Number(n) => ArgValue::String(n.to_string()),
        CommandDataOptionValue::User(id) => ArgValue::String(id.get().to_string()),
        CommandDataOptionValue::Channel(id) => ArgValue::String(id.get().to_string()),
        CommandDataOptionValue::Role(id) => ArgValue::String(id.get().to_string()),
        CommandDataOptionValue::Mentionable(id) => ArgValue::String(id.get().to_string()),
        CommandDataOptionValue::Attachment(id) => ArgValue::String(id.get().to_string()),
        CommandDataOptionValue::Autocomplete { value, .. } => ArgValue::String(value.clone()),
        _ => return None,
    })
}

/// Parses configured account ids (`"123"` or `"discord:123"`).
pub fn parse_user_ids(ids: &[String]) -> anyhow::Result<HashSet<UserId>> {
    ids.iter()
        .map(|s| {
            let raw = s.trim();
            let raw = raw.strip_prefix("discord:").unwrap_or(raw);
            match raw.parse::<u64>() {
                Ok(n) if n != 0 => Ok(UserId::new(n)),
                _ => anyhow::bail!("invalid Discord user id `{s}`"),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn user(id: u64, name: &str, global: Option<&str>, bot: bool) -> serde_json::Value {
        json!({
            "id": id.to_string(),
            "username": name,
            "global_name": global,
            "discriminator": "0",
            "avatar": null,
            "bot": bot,
        })
    }

    fn message(extra: serde_json::Value) -> Message {
        let mut base = json!({
            "id": "1000",
            "channel_id": "200",
            "guild_id": "300",
            "author": user(42, "alice_w", Some("Alice"), false),
            "member": { "nick": "Ali", "roles": [], "joined_at": "2024-01-01T00:00:00Z",
                        "deaf": false, "mute": false, "flags": 0 },
            "content": "hi <@7>",
            "timestamp": "2026-11-01T12:00:00.000Z",
            "edited_timestamp": null,
            "tts": false,
            "mention_everyone": false,
            "mentions": [],
            "mention_roles": [],
            "attachments": [],
            "embeds": [],
            "pinned": false,
            "type": 0,
        });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn selves() -> HashSet<UserId> {
        parse_user_ids(&["7".into(), "discord:8".into()]).unwrap()
    }

    #[test]
    fn maps_guild_message() {
        let msg = message(json!({
            "mentions": [user(7, "miyoria", None, true)],
            "attachments": [{
                "id": "5", "filename": "cat.png", "size": 10, "url": "https://cdn/cat.png",
                "proxy_url": "https://proxy/cat.png", "content_type": "image/png"
            }],
        }));
        let m = incoming_message(&msg, ContextKind::Thread, &selves());
        assert_eq!(m.id.id, "1000");
        assert_eq!(
            m.id.context,
            ContextKey {
                platform: platform(),
                scope: Some("300".into()),
                channel: "200".into(),
                kind: ContextKind::Thread,
            }
        );
        assert_eq!(m.author.display_name, "Ali");
        assert_eq!(m.author.account.id, "42");
        assert!(!m.author.is_bot);
        assert!(m.mentions_self);
        assert!(!m.reply_to_self);
        assert_eq!(m.attachments[0].filename, "cat.png");
        assert_eq!(m.attachments[0].content_type.as_deref(), Some("image/png"));
        assert_eq!(m.ts.to_rfc3339(), "2026-11-01T12:00:00+00:00");
    }

    #[test]
    fn maps_dm_reply_to_self_account() {
        let referenced = json!({
            "id": "999", "channel_id": "200",
            "author": user(8, "miyo_self", None, false),
            "content": "earlier", "timestamp": "2026-11-01T11:00:00Z",
            "edited_timestamp": null, "tts": false, "mention_everyone": false,
            "mentions": [], "mention_roles": [], "attachments": [], "embeds": [],
            "pinned": false, "type": 0,
        });
        let msg = message(json!({
            "guild_id": null,
            "member": null,
            "type": 19,
            "referenced_message": referenced,
        }));
        let m = incoming_message(&msg, ContextKind::Channel, &selves());
        assert_eq!(m.id.context.kind, ContextKind::Dm);
        assert_eq!(m.id.context.scope, None);
        assert_eq!(m.author.display_name, "Alice");
        assert!(m.reply_to_self);
        assert!(!m.mentions_self);
    }

    #[test]
    fn display_name_fallbacks() {
        let u: User = serde_json::from_value(user(1, "bob", None, false)).unwrap();
        assert_eq!(display_name(&u, None), "bob");
        assert_eq!(display_name(&u, Some("Bobby")), "Bobby");
        let u: User = serde_json::from_value(user(1, "bob", Some("Bob!"), false)).unwrap();
        assert_eq!(display_name(&u, None), "Bob!");
    }

    #[test]
    fn flattens_subcommand_groups() {
        let options: Vec<CommandDataOption> = serde_json::from_value(json!([{
            "name": "module", "type": 2, "options": [{
                "name": "enable", "type": 1, "options": [
                    { "name": "id", "type": 3, "value": "llm" },
                    { "name": "force", "type": 5, "value": true },
                    { "name": "times", "type": 4, "value": 3 },
                ]
            }]
        }]))
        .unwrap();
        let (path, args) = command_path("admin", &options);
        assert_eq!(path, ["admin", "module", "enable"]);
        assert_eq!(args["id"], ArgValue::String("llm".into()));
        assert_eq!(args["force"], ArgValue::Boolean(true));
        assert_eq!(args["times"], ArgValue::Integer(3));

        let (path, args) = command_path("ping", &[]);
        assert_eq!(path, ["ping"]);
        assert!(args.is_empty());
    }

    #[test]
    fn guild_admin_detection() {
        let member = |perms: &str| -> Member {
            serde_json::from_value(json!({
                "user": user(1, "x", None, false), "roles": [], "joined_at": null,
                "deaf": false, "mute": false, "flags": 0, "permissions": perms,
                "guild_id": "300",
            }))
            .unwrap()
        };
        assert!(is_guild_admin(Some(&member("8")))); // ADMINISTRATOR
        assert!(is_guild_admin(Some(&member("32")))); // MANAGE_GUILD
        assert!(!is_guild_admin(Some(&member("2048")))); // SEND_MESSAGES
        assert!(!is_guild_admin(None));
    }

    #[test]
    fn maps_resolved_users() {
        let resolved: CommandDataResolved = serde_json::from_value(json!({
            "users": {
                "5": user(5, "eve", Some("Eve"), false),
                "6": user(6, "dm_only", None, false),
            },
            "members": {
                "5": { "nick": "Evie", "roles": ["70", "71"], "joined_at": null,
                       "deaf": false, "mute": false, "flags": 0, "permissions": "8" },
            },
        }))
        .unwrap();
        let users = resolved_users(&resolved);
        assert_eq!(
            users["5"],
            ResolvedUser {
                display_name: "Evie".into(),
                platform_roles: vec!["70".into(), "71".into()],
                is_guild_admin: true,
            }
        );
        assert_eq!(users["6"].display_name, "dm_only");
        assert!(users["6"].platform_roles.is_empty() && !users["6"].is_guild_admin);
        assert_eq!(role_ids(&[RoleId::new(3)]), ["3"]);
    }

    #[test]
    fn parses_user_ids() {
        assert_eq!(selves().len(), 2);
        assert!(parse_user_ids(&["abc".into()]).is_err());
        assert!(parse_user_ids(&["0".into()]).is_err());
    }
}
