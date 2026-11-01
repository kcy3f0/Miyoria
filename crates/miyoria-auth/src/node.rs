//! Permission node patterns.

/// Does `pattern` cover `node`?
///
/// - `"*"` covers every node.
/// - `"queue.*"` covers `"queue"` and everything below it (`"queue.skip"`,
///   `"queue.skip.self"`), but not `"queuex"`.
/// - Anything else must match exactly.
///
/// Patterns can be checked against patterns: `"admin.*"` covers
/// `"admin.role.*"`.
pub fn matches(pattern: &str, node: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    match pattern.strip_suffix(".*") {
        Some(prefix) => {
            node == prefix
                || node
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with('.'))
        }
        None => pattern == node,
    }
}

/// A node or pattern that can be stored: dot separated lowercase segments of
/// `a-z 0-9 _ -`, optionally ending in `.*`, or just `*`.
pub fn is_valid_pattern(pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let body = pattern.strip_suffix(".*").unwrap_or(pattern);
    pattern.len() <= 128
        && !body.is_empty()
        && body.split('.').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_matching() {
        assert!(matches("*", "anything.at.all"));
        assert!(matches("queue.*", "queue"));
        assert!(matches("queue.*", "queue.skip"));
        assert!(matches("queue.*", "queue.skip.self"));
        assert!(!matches("queue.*", "queuex"));
        assert!(!matches("queue.*", "queue_x.skip"));
        assert!(matches("voice.consent", "voice.consent"));
        assert!(!matches("voice.consent", "voice.consent.x"));
        assert!(!matches("voice.consent", "voice"));
        assert!(matches("admin.*", "admin.role.*"));
        assert!(!matches("memory.self.*", "memory.*"));
    }

    #[test]
    fn pattern_validation() {
        for ok in ["*", "ping", "admin.*", "tools.mcp.my-server.do_it", "a1.b2"] {
            assert!(is_valid_pattern(ok), "{ok}");
        }
        for bad in ["", ".*", "a..b", "A.b", "a.*.b", "a b", "a.", "*.a", "a*"] {
            assert!(!is_valid_pattern(bad), "{bad}");
        }
    }
}
