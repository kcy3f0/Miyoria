use std::sync::Arc;

use miyoria_types::{Envelope, Event, ModuleId, TurnId};
use tokio::sync::broadcast;
use tracing::warn;

const DEFAULT_CAPACITY: usize = 4096;

/// In-process publish / subscribe bus. Cheap to clone.
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Arc<Envelope>>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn publish_envelope(&self, envelope: Envelope) {
        // No subscribers is not an error.
        let _ = self.tx.send(Arc::new(envelope));
    }

    pub fn publish(&self, source: &ModuleId, event: Event, correlation: Option<TurnId>) {
        let mut envelope = Envelope::new(source.clone(), event);
        envelope.correlation = correlation;
        self.publish_envelope(envelope);
    }

    pub fn subscribe(&self, filter: TopicFilter) -> Subscription {
        Subscription {
            rx: self.tx.subscribe(),
            filter,
        }
    }
}

/// Matches dotted topics. `"platform.*"` matches every topic under
/// `platform.`, `"*"` matches everything, anything else must match exactly.
#[derive(Clone, Debug)]
pub struct TopicFilter {
    patterns: Vec<String>,
}

impl TopicFilter {
    pub fn all() -> Self {
        Self {
            patterns: vec!["*".to_owned()],
        }
    }

    pub fn new<I, S>(patterns: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            patterns: patterns.into_iter().map(Into::into).collect(),
        }
    }

    pub fn matches(&self, topic: &str) -> bool {
        self.patterns.iter().any(|p| {
            if p == "*" {
                true
            } else if let Some(prefix) = p.strip_suffix(".*") {
                topic
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with('.'))
            } else {
                p == topic
            }
        })
    }
}

pub struct Subscription {
    rx: broadcast::Receiver<Arc<Envelope>>,
    filter: TopicFilter,
}

impl Subscription {
    /// Waits for the next matching event. Returns `None` once the bus is gone.
    /// A slow subscriber that falls behind skips the missed events.
    pub async fn recv(&mut self) -> Option<Arc<Envelope>> {
        loop {
            match self.rx.recv().await {
                Ok(env) if self.filter.matches(env.topic()) => return Some(env),
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(skipped = n, "event subscriber lagged");
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_filter() {
        let f = TopicFilter::new(["platform.*", "agent.decision"]);
        assert!(f.matches("platform.message.created"));
        assert!(f.matches("agent.decision"));
        assert!(!f.matches("platformx.y"));
        assert!(!f.matches("platform"));
        assert!(!f.matches("agent.turn.started"));
        assert!(TopicFilter::all().matches("anything"));
    }

    #[tokio::test]
    async fn subscription_filters() {
        let bus = EventBus::default();
        let mut sub = bus.subscribe(TopicFilter::new(["custom.b"]));
        let src = ModuleId::from("test");
        for topic in ["custom.a", "custom.b"] {
            bus.publish(
                &src,
                Event::Custom {
                    topic: topic.to_owned(),
                    payload: serde_json::Value::Null,
                },
                None,
            );
        }
        let env = sub.recv().await.unwrap();
        assert_eq!(env.topic(), "custom.b");
    }
}
