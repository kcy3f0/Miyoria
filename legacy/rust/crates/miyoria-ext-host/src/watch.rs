//! Polling file watcher for dev mode (no platform watcher dependency).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::manifest::{ExtensionManifest, MANIFEST_FILE};

/// Directories never watched or copied.
pub(crate) const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target"];

/// Path → (modified, size) of every watched file.
pub type Snapshot = BTreeMap<PathBuf, (Option<SystemTime>, u64)>;

/// Paths whose changes restart an extension: the manifest, the config
/// schema and the directory holding the entry (recursively).
pub fn watch_roots(dir: &Path, manifest: &ExtensionManifest) -> Vec<PathBuf> {
    let mut roots = vec![dir.join(MANIFEST_FILE)];
    if let Some(schema) = &manifest.config.schema {
        roots.push(dir.join(schema));
    }
    let entry_dir = Path::new(&manifest.entry)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| dir.join(p))
        .unwrap_or_else(|| dir.to_path_buf());
    roots.push(entry_dir);
    roots
}

pub fn snapshot(roots: &[PathBuf]) -> Snapshot {
    let mut out = Snapshot::new();
    for root in roots {
        walk(root, &mut out, 0);
    }
    out
}

fn walk(path: &Path, out: &mut Snapshot, depth: usize) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.is_file() {
        out.insert(path.to_path_buf(), (meta.modified().ok(), meta.len()));
        return;
    }
    if !meta.is_dir() || depth > 16 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if SKIP_DIRS.iter().any(|s| name == *s) {
            continue;
        }
        walk(&entry.path(), out, depth + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_changes_and_skips_node_modules() {
        let dir = std::env::temp_dir().join(format!("miyoria-watch-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::create_dir_all(dir.join("dist/node_modules")).unwrap();
        std::fs::write(dir.join(MANIFEST_FILE), "x").unwrap();
        std::fs::write(dir.join("dist/index.js"), "1").unwrap();
        let manifest = ExtensionManifest::parse(
            "id = \"w\"\nversion = \"1\"\nruntime = \"node\"\nentry = \"dist/index.js\"",
        )
        .unwrap();
        let roots = watch_roots(&dir, &manifest);
        let a = snapshot(&roots);
        assert_eq!(a.len(), 2);
        std::fs::write(dir.join("dist/node_modules/x.js"), "1").unwrap();
        std::fs::write(dir.join("src.ts"), "outside the entry dir").unwrap();
        assert_eq!(snapshot(&roots), a);
        std::fs::write(dir.join("dist/index.js"), "22").unwrap();
        assert_ne!(snapshot(&roots), a);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
