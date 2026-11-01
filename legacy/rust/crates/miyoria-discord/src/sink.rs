use std::sync::Arc;

use anyhow::Context as _;
use async_trait::async_trait;
use miyoria_types::{ContextKey, MessageRef, OutgoingMessage, PlatformId, PlatformSink};
use serenity::all::{
    ChannelId, CreateAllowedMentions, CreateMessage, Http, MessageId, MessageReference,
    MessageReferenceKind, ReactionType,
};

use crate::mapping::{PLATFORM, platform};
use crate::split::{MAX_MESSAGE_LEN, split_message};

/// Executes output actions through the bot account's REST client.
pub struct DiscordSink {
    http: Arc<Http>,
}

impl DiscordSink {
    pub fn new(http: Arc<Http>) -> Self {
        Self { http }
    }
}

/// Parses a non-zero Discord snowflake.
pub fn snowflake(s: &str, what: &str) -> anyhow::Result<u64> {
    match s.parse::<u64>() {
        Ok(n) if n != 0 => Ok(n),
        _ => anyhow::bail!("invalid Discord {what} id `{s}`"),
    }
}

fn channel_of(context: &ContextKey) -> anyhow::Result<ChannelId> {
    anyhow::ensure!(
        context.platform.as_str() == PLATFORM,
        "context `{context}` is not a Discord context"
    );
    Ok(ChannelId::new(snowflake(&context.channel, "channel")?))
}

#[async_trait]
impl PlatformSink for DiscordSink {
    fn platform(&self) -> PlatformId {
        platform()
    }

    /// Sends the text split into Discord-sized chunks. Only the first chunk
    /// replies to `reply_to` (without pinging its author); its ref is returned.
    async fn send(
        &self,
        context: &ContextKey,
        message: OutgoingMessage,
    ) -> anyhow::Result<MessageRef> {
        let channel = channel_of(context)?;
        let chunks = split_message(&message.text, MAX_MESSAGE_LEN);
        anyhow::ensure!(!chunks.is_empty(), "cannot send an empty message");
        let mut reference = match &message.reply_to {
            Some(r) => Some(
                MessageReference::new(MessageReferenceKind::Default, channel_of(&r.context)?)
                    .message_id(MessageId::new(snowflake(&r.id, "message")?))
                    .fail_if_not_exists(false),
            ),
            None => None,
        };
        let mut first = None;
        for chunk in chunks {
            let mut builder = CreateMessage::new().content(chunk).allowed_mentions(
                CreateAllowedMentions::new()
                    .all_users(true)
                    .replied_user(false),
            );
            if let Some(reference) = reference.take() {
                builder = builder.reference_message(reference);
            }
            let sent = channel
                .send_message(&self.http, builder)
                .await
                .with_context(|| format!("sending message to {context}"))?;
            first.get_or_insert(sent.id);
        }
        Ok(MessageRef {
            context: context.clone(),
            id: first.expect("at least one chunk").get().to_string(),
        })
    }

    async fn react(&self, message: &MessageRef, emoji: &str) -> anyhow::Result<()> {
        let channel = channel_of(&message.context)?;
        let id = MessageId::new(snowflake(&message.id, "message")?);
        self.http
            .create_reaction(channel, id, &ReactionType::Unicode(emoji.to_owned()))
            .await
            .with_context(|| format!("reacting to message {} in {}", message.id, message.context))
    }

    async fn typing(&self, context: &ContextKey) -> anyhow::Result<()> {
        self.http
            .broadcast_typing(channel_of(context)?)
            .await
            .with_context(|| format!("typing in {context}"))
    }
}
