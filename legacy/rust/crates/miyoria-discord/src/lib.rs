//! Discord bot account adapter (module `platform.discord.bot`).
//!
//! This is the official bot account: it reads and writes text messages,
//! reacts, shows typing and serves slash commands from the
//! [`CommandRegistry`](miyoria_commands::CommandRegistry). It never joins
//! voice; that is the separate self-account voice node.
//!
//! # Developer Portal setup
//!
//! 1. Create an application at <https://discord.com/developers/applications>
//!    and add a bot under **Bot**. Copy its token into the environment
//!    (e.g. `DISCORD_BOT_TOKEN`) and reference it as
//!    `token = "${DISCORD_BOT_TOKEN}"`.
//! 2. Under **Bot → Privileged Gateway Intents**, enable **Message Content
//!    Intent**. Without it the gateway refuses to connect (disallowed
//!    intents) and the module keeps failing.
//! 3. Invite the bot with the `bot` and `applications.commands` scopes and
//!    the permissions View Channels, Send Messages, Send Messages in Threads,
//!    Read Message History and Add Reactions.
//! 4. For instant command updates during development, list your server ids
//!    in `command_guilds`; otherwise commands are registered globally.
//!
//! Intents used: see [`intents`].

mod config;
mod handler;
pub mod mapping;
mod module;
mod sink;
pub mod slash;
pub mod split;

pub use config::DiscordConfig;
pub use module::{DiscordBotModule, intents};
pub use sink::DiscordSink;
