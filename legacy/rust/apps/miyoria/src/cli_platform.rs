//! `platform.cli`: talk to her from the terminal (`miyoria chat`), no Discord
//! needed. Every line typed is a DM from "you"; her replies are printed.

use std::io::Write;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use miyoria_kernel::{Module, ModuleContext, ModuleManifest};
use miyoria_types::{
    AccountRef, Author, ContextKey, ContextKind, Event, IncomingMessage, MessageRef,
    OutgoingMessage, PlatformId, PlatformSink, PlatformSinks,
};
use tokio::io::{AsyncBufReadExt, BufReader};

pub const PLATFORM: &str = "cli";

pub struct CliPlatform {
    manifest: ModuleManifest,
    user_name: String,
    her_name: String,
    sinks: Mutex<Option<Arc<PlatformSinks>>>,
}

impl CliPlatform {
    pub const ID: &'static str = "platform.cli";

    pub fn new(user_name: impl Into<String>, her_name: impl Into<String>) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Terminal chat")
                .description("Chat with her from the terminal"),
            user_name: user_name.into(),
            her_name: her_name.into(),
            sinks: Mutex::new(None),
        }
    }
}

fn context() -> ContextKey {
    ContextKey {
        platform: PlatformId::new(PLATFORM),
        scope: None,
        channel: "repl".into(),
        kind: ContextKind::Dm,
    }
}

fn account(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new(PLATFORM),
        id: id.into(),
    }
}

struct Sink {
    her_name: String,
}

#[async_trait]
impl PlatformSink for Sink {
    fn platform(&self) -> PlatformId {
        PlatformId::new(PLATFORM)
    }

    async fn send(
        &self,
        context: &ContextKey,
        message: OutgoingMessage,
    ) -> anyhow::Result<MessageRef> {
        let mut out = std::io::stdout().lock();
        writeln!(
            out,
            "\n\x1b[36m{}\x1b[0m: {}\n",
            self.her_name, message.text
        )?;
        write!(out, "> ")?;
        out.flush()?;
        Ok(MessageRef {
            context: context.clone(),
            id: ulid_like(),
        })
    }

    async fn react(&self, _message: &MessageRef, emoji: &str) -> anyhow::Result<()> {
        println!("  ({} reacted {emoji})", self.her_name);
        Ok(())
    }

    async fn typing(&self, _context: &ContextKey) -> anyhow::Result<()> {
        Ok(())
    }
}

fn ulid_like() -> String {
    miyoria_types::EventId::new().to_string()
}

#[async_trait]
impl Module for CliPlatform {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let sinks = ctx.services().require::<PlatformSinks>()?;
        sinks.register(Arc::new(Sink {
            her_name: self.her_name.clone(),
        }));
        *self.sinks.lock().expect("lock poisoned") = Some(sinks);
        ctx.publish(Event::PlatformReady {
            platform: PlatformId::new(PLATFORM),
            self_account: account("her"),
        });

        let user_name = self.user_name.clone();
        let task_ctx = ctx.clone();
        ctx.spawn("stdin", async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            print!("> ");
            std::io::stdout().flush()?;
            loop {
                let line = tokio::select! {
                    () = task_ctx.cancellation().cancelled() => return Ok(()),
                    line = lines.next_line() => line?,
                };
                let Some(line) = line else { return Ok(()) };
                let text = line.trim();
                if text.is_empty() {
                    print!("> ");
                    std::io::stdout().flush()?;
                    continue;
                }
                task_ctx.publish(Event::PlatformMessageCreated(IncomingMessage {
                    id: MessageRef {
                        context: context(),
                        id: ulid_like(),
                    },
                    author: Author {
                        account: account("you"),
                        display_name: user_name.clone(),
                        is_bot: false,
                    },
                    text: text.to_owned(),
                    mentions_self: false,
                    reply_to_self: false,
                    attachments: Vec::new(),
                    ts: Utc::now(),
                }));
            }
        });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        if let Some(sinks) = self.sinks.lock().expect("lock poisoned").take() {
            sinks.unregister(&PlatformId::new(PLATFORM));
        }
        Ok(())
    }
}
