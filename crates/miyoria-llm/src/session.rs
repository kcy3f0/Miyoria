//! Stable conversation ids for [`ChatRequest::session`](crate::ChatRequest).
//!
//! Providers that support it use the id for routing and prompt caching, so
//! it must stay the same for every request of one conversation. Raw platform
//! ids never appear in it: the context is hashed.

use std::fmt::Display;

use miyoria_types::ContextKey;
use sha2::{Digest, Sha256};

/// First 16 hex digits of SHA-256 over the context's display form and kind.
pub fn context_hash(context: &ContextKey) -> String {
    let digest = Sha256::digest(format!("{context}|{:?}", context.kind).as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// `miyoria-<profile>-<context hash>` for a conversation context.
pub fn context_session(profile: impl Display, context: &ContextKey) -> String {
    session_id(profile, context_hash(context))
}

/// `miyoria-<profile>-<scope>`; the profile id is reduced to header-safe
/// characters.
pub fn session_id(profile: impl Display, scope: impl Display) -> String {
    let profile: String = profile
        .to_string()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("miyoria-{profile}-{scope}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use miyoria_types::{ContextKind, PlatformId};

    fn key(channel: &str, kind: ContextKind) -> ContextKey {
        ContextKey {
            platform: PlatformId("discord".into()),
            scope: Some("guild-123".into()),
            channel: channel.into(),
            kind,
        }
    }

    #[test]
    fn context_ids_are_stable_distinct_and_opaque() {
        let a = context_session("deepseek-chan", &key("chan-1", ContextKind::Channel));
        assert_eq!(
            a,
            context_session("deepseek-chan", &key("chan-1", ContextKind::Channel))
        );
        assert_ne!(
            a,
            context_session("deepseek-chan", &key("chan-2", ContextKind::Channel))
        );
        assert_ne!(
            a,
            context_session("deepseek-chan", &key("chan-1", ContextKind::Thread))
        );
        assert!(a.starts_with("miyoria-deepseek-chan-"), "{a}");
        assert_eq!(a.len(), "miyoria-deepseek-chan-".len() + 16);
        assert!(!a.contains("123") && !a.contains("chan-1"), "{a}");
    }

    #[test]
    fn profile_is_made_header_safe() {
        assert_eq!(session_id("a b/é", "x"), "miyoria-a_b__-x");
    }
}
