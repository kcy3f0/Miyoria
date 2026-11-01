//! Pure helpers: tool filters, registry names and result flattening.

use std::collections::BTreeSet;

use rmcp::model::{CallToolResult, ContentBlock, ResourceContents};

/// Longest tool name the registry accepts.
pub const MAX_TOOL_NAME: usize = 64;

/// Matches `text` against a pattern with `*` (any run) and `?` (one char).
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Allow / deny lists of tool name patterns.
#[derive(Clone, Debug, Default)]
pub struct ToolFilter {
    allow: Vec<String>,
    deny: Vec<String>,
}

impl ToolFilter {
    pub fn new(allow: &[String], deny: &[String]) -> Self {
        Self {
            allow: allow.to_vec(),
            deny: deny.to_vec(),
        }
    }

    /// Deny wins; an empty allow list allows everything not denied.
    pub fn allows(&self, tool: &str) -> bool {
        if self.deny.iter().any(|p| glob_match(p, tool)) {
            return false;
        }
        self.allow.is_empty() || self.allow.iter().any(|p| glob_match(p, tool))
    }
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// FNV-1a, folded to 32 bits, as 8 hex digits. Stable across runs.
fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:08x}", (h ^ (h >> 32)) as u32)
}

/// Registry name `mcp_<server>_<tool>`, sanitized to the registry's rules and
/// at most 64 characters. If the plain name is too long or already in `taken`
/// (two tools that sanitize alike), a hash of the original names is used to
/// keep it unique. Returns `None` only if even that is taken.
pub fn registry_name(server: &str, tool: &str, taken: &BTreeSet<String>) -> Option<String> {
    let plain = format!("mcp_{}_{}", sanitize(server), sanitize(tool));
    if plain.len() <= MAX_TOOL_NAME && !taken.contains(&plain) {
        return Some(plain);
    }
    let hash = short_hash(&format!("{server}\0{tool}"));
    let keep = MAX_TOOL_NAME - hash.len() - 1;
    let mut prefix = plain;
    prefix.truncate(keep);
    let hashed = format!("{prefix}_{hash}");
    (!taken.contains(&hashed)).then_some(hashed)
}

/// Cuts `text` to `max` characters (0 = unlimited) and notes the cut.
pub fn truncate_chars(text: String, max: usize) -> String {
    if max == 0 {
        return text;
    }
    let Some((cut, _)) = text.char_indices().nth(max) else {
        return text;
    };
    let dropped = text[cut..].chars().count();
    let mut out = text;
    out.truncate(cut);
    out.push_str(&format!("\n[truncated: {dropped} more characters]"));
    out
}

/// Flattens a tool result into text for the model: text parts verbatim,
/// other parts as short placeholders. Structured content is used when there
/// is no content at all.
pub fn flatten_result(result: &CallToolResult) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in &result.content {
        parts.push(match block {
            ContentBlock::Text(t) => t.text.clone(),
            ContentBlock::Image(i) => format!("[image omitted: {}]", i.mime_type),
            ContentBlock::Audio(a) => format!("[audio omitted: {}]", a.mime_type),
            ContentBlock::ResourceLink(r) => format!("[resource link: {} {}]", r.name, r.uri),
            ContentBlock::Resource(r) => match &r.resource {
                ResourceContents::TextResourceContents { uri, text, .. } => {
                    format!("[resource {uri}]\n{text}")
                }
                ResourceContents::BlobResourceContents { uri, mime_type, .. } => format!(
                    "[binary resource omitted: {uri} ({})]",
                    mime_type.as_deref().unwrap_or("unknown type")
                ),
                _ => "[unsupported resource omitted]".to_owned(),
            },
            _ => "[unsupported content omitted]".to_owned(),
        });
    }
    if parts.is_empty()
        && let Some(structured) = &result.structured_content
    {
        parts.push(structured.to_string());
    }
    if parts.is_empty() {
        return "(empty result)".to_owned();
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs() {
        assert!(glob_match("*", "anything"));
        assert!(glob_match("read_*", "read_file"));
        assert!(!glob_match("read_*", "write_file"));
        assert!(glob_match("*delete*", "bulk_delete_all"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("a?c", "ac"));
        assert!(glob_match("a*b*c", "aXXbYYc"));
        assert!(!glob_match("a*b*c", "aXXbYY"));
        assert!(glob_match("exact", "exact"));
        assert!(!glob_match("exact", "exactly"));
        assert!(glob_match("", ""));
    }

    #[test]
    fn filter_deny_wins() {
        let f = ToolFilter::new(&["read_*".into(), "list".into()], &["read_secret".into()]);
        assert!(f.allows("read_file"));
        assert!(f.allows("list"));
        assert!(!f.allows("read_secret"));
        assert!(!f.allows("write"));
        assert!(ToolFilter::default().allows("x"));
    }

    #[test]
    fn names_are_sanitized_and_bounded() {
        let none = BTreeSet::new();
        assert_eq!(
            registry_name("fs", "read.file", &none).unwrap(),
            "mcp_fs_read_file"
        );
        let long = "t".repeat(100);
        let n = registry_name("fs", &long, &none).unwrap();
        assert_eq!(n.len(), MAX_TOOL_NAME);
        assert!(n.starts_with("mcp_fs_ttt"));
        // Stable, and distinct for distinct originals.
        assert_eq!(n, registry_name("fs", &long, &none).unwrap());
        let long2 = format!("{}x", "t".repeat(99));
        assert_ne!(n, registry_name("fs", &long2, &none).unwrap());
        // Names that sanitize alike get disambiguated.
        let taken: BTreeSet<String> = ["mcp_fs_a_b".to_owned()].into();
        let alt = registry_name("fs", "a.b", &taken).unwrap();
        assert_ne!(alt, "mcp_fs_a_b");
        assert!(alt.len() <= MAX_TOOL_NAME);
        // Non-ASCII is replaced.
        assert_eq!(registry_name("fs", "查詢", &none).unwrap(), "mcp_fs___");
    }

    #[test]
    fn truncation_is_char_safe() {
        assert_eq!(truncate_chars("abc".into(), 10), "abc");
        assert_eq!(truncate_chars("abc".into(), 3), "abc");
        assert_eq!(truncate_chars("abc".into(), 0), "abc");
        let t = truncate_chars("你好世界!".into(), 2);
        assert!(t.starts_with("你好\n[truncated: 3 more characters]"));
    }

    #[test]
    fn flattens_parts() {
        let r = CallToolResult::success(vec![
            ContentBlock::text("hello"),
            ContentBlock::image("AAAA", "image/png"),
            ContentBlock::embedded_text("file:///a", "body"),
        ]);
        let s = flatten_result(&r);
        assert!(s.contains("hello"));
        assert!(s.contains("[image omitted: image/png]"));
        assert!(s.contains("[resource file:///a]\nbody"));
        assert_eq!(
            flatten_result(&CallToolResult::success(vec![])),
            "(empty result)"
        );
    }
}
