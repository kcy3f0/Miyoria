use std::collections::VecDeque;

use async_trait::async_trait;
use futures::StreamExt;
use parking_lot::Mutex;

use crate::types::{ChatProvider, ChatRequest, ChatStream, StreamEvent, Usage};

enum Scripted {
    Reply(Vec<StreamEvent>),
    Fail(String),
}

/// Scripted provider for tests. Each call pops the next scripted reply; the
/// last one repeats. Requests are recorded for assertions.
pub struct MockProvider {
    name: String,
    script: Mutex<VecDeque<Scripted>>,
    requests: Mutex<Vec<ChatRequest>>,
}

impl MockProvider {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            script: Mutex::new(VecDeque::new()),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// Replies with `text`, streamed in a few chunks.
    pub fn reply(self, text: &str) -> Self {
        let mut events: Vec<StreamEvent> = text
            .split_inclusive(['。', '!', '?', '!', '?', '\n'])
            .map(|s| StreamEvent::TextDelta(s.to_owned()))
            .collect();
        events.push(StreamEvent::Done {
            finish_reason: Some("stop".into()),
            usage: Some(Usage {
                prompt_tokens: 10,
                completion_tokens: 5,
                cached_prompt_tokens: None,
            }),
        });
        self.events(events)
    }

    pub fn events(self, events: Vec<StreamEvent>) -> Self {
        self.script.lock().push_back(Scripted::Reply(events));
        self
    }

    pub fn fail(self, message: &str) -> Self {
        self.script
            .lock()
            .push_back(Scripted::Fail(message.to_owned()));
        self
    }

    pub fn requests(&self) -> Vec<ChatRequest> {
        self.requests.lock().clone()
    }
}

#[async_trait]
impl ChatProvider for MockProvider {
    fn name(&self) -> &str {
        &self.name
    }

    async fn stream(&self, request: ChatRequest) -> anyhow::Result<ChatStream> {
        self.requests.lock().push(request);
        let mut script = self.script.lock();
        let next = if script.len() > 1 {
            script.pop_front()
        } else {
            script.front().map(|s| match s {
                Scripted::Reply(e) => Scripted::Reply(e.clone()),
                Scripted::Fail(m) => Scripted::Fail(m.clone()),
            })
        };
        match next {
            Some(Scripted::Reply(events)) => {
                Ok(futures::stream::iter(events.into_iter().map(Ok)).boxed())
            }
            Some(Scripted::Fail(m)) => anyhow::bail!(m),
            None => anyhow::bail!("mock provider `{}` has no scripted reply", self.name),
        }
    }
}
