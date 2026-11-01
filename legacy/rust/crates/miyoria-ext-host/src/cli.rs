//! Library side of `miyoria ext new | list | install | validate`.
//!
//! These functions are synchronous and touch only the file system (and the
//! `git` binary for installs); the app wires them to CLI subcommands.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Context as _;
use miyoria_kernel::Config;

use crate::config::{ExtensionSettings, HostConfig};
use crate::host::find_extension_dirs;
use crate::manifest::{ExtensionManifest, MANIFEST_FILE};
use crate::watch::SKIP_DIRS;

/// Outcome of [`validate`].
#[derive(Clone, Debug, Default)]
pub struct Validation {
    pub manifest: Option<ExtensionManifest>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl Validation {
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }
}

/// Checks the manifest of the extension in `dir` and the files it names.
pub fn validate(dir: &Path) -> Validation {
    let mut v = Validation::default();
    let manifest = match ExtensionManifest::load(dir) {
        Ok(m) => m,
        Err(e) => {
            v.errors.push(e.to_string());
            return v;
        }
    };
    v.errors.extend(manifest.errors());
    v.warnings.extend(manifest.warnings());
    if !manifest.entry.trim().is_empty() && !dir.join(&manifest.entry).is_file() {
        v.warnings.push(format!(
            "entry `{}` does not exist yet (build the extension first?)",
            manifest.entry
        ));
    }
    if let Some(schema) = &manifest.config.schema {
        let path = dir.join(schema);
        match std::fs::read_to_string(&path) {
            Err(e) => v.errors.push(format!("config schema `{schema}`: {e}")),
            Ok(text) => {
                if let Err(e) = serde_json::from_str::<serde_json::Value>(&text) {
                    v.errors
                        .push(format!("config schema `{schema}` is not JSON: {e}"));
                }
            }
        }
    }
    v.manifest = Some(manifest);
    v
}

/// One row of `ext list`.
#[derive(Clone, Debug)]
pub struct ExtensionListing {
    pub dir: PathBuf,
    /// `None` when the manifest cannot be read.
    pub manifest: Option<ExtensionManifest>,
    /// From `[extensions."<id>"] enabled`, default `true`.
    pub enabled: bool,
    /// Placement `core` or `any`.
    pub runs_on_core: bool,
    pub problems: Vec<String>,
}

/// Every extension directory found under the configured dirs.
pub fn list(config: &Config, base: &Path) -> anyhow::Result<Vec<ExtensionListing>> {
    let host = HostConfig::from_config(config)?;
    let mut out = Vec::new();
    for root in host.resolved_dirs(base) {
        for dir in find_extension_dirs(&root) {
            let v = validate(&dir);
            let (enabled, runs_on_core) = match &v.manifest {
                Some(m) => (
                    ExtensionSettings::from_config(config, &m.id)?
                        .enabled
                        .unwrap_or(true),
                    m.placement.runs_on_core(),
                ),
                None => (false, false),
            };
            let mut problems = v.errors;
            problems.extend(v.warnings);
            out.push(ExtensionListing {
                dir,
                manifest: v.manifest,
                enabled,
                runs_on_core,
                problems,
            });
        }
    }
    Ok(out)
}

/// `ext install` result.
#[derive(Clone, Debug)]
pub struct Installed {
    pub id: String,
    pub dir: PathBuf,
    pub warnings: Vec<String>,
}

/// Whether `source` should be cloned with git rather than copied.
pub fn is_git_source(source: &str) -> bool {
    ["https://", "http://", "git@", "ssh://", "git://", "git+"]
        .iter()
        .any(|p| source.starts_with(p))
        || source.ends_with(".git")
}

/// Copies a local extension directory, or clones a git URL with the `git`
/// binary, into the first configured extension dir as `<dir>/<id>`.
pub fn install(config: &Config, base: &Path, source: &str) -> anyhow::Result<Installed> {
    let host = HostConfig::from_config(config)?;
    let target_root = host
        .resolved_dirs(base)
        .into_iter()
        .next()
        .context("`[modules.extensions] dirs` is empty")?;
    std::fs::create_dir_all(&target_root)
        .with_context(|| format!("creating {}", target_root.display()))?;

    let local = Path::new(source);
    let (staged, cleanup) = if local.is_dir() {
        (local.to_path_buf(), false)
    } else if is_git_source(source) {
        let tmp = target_root.join(format!(".install-{}", ulid::Ulid::new()));
        let url = source.strip_prefix("git+").unwrap_or(source);
        let status = Command::new("git")
            .args(["clone", "--depth", "1", "--", url])
            .arg(&tmp)
            .status()
            .context("running `git` (is it installed?)")?;
        if !status.success() {
            let _ = std::fs::remove_dir_all(&tmp);
            anyhow::bail!("`git clone {url}` failed ({status})");
        }
        (tmp, true)
    } else {
        anyhow::bail!("`{source}` is neither a directory nor a git URL");
    };

    let result = (|| {
        let v = validate(&staged);
        if !v.is_ok() {
            anyhow::bail!("invalid extension: {}", v.errors.join("; "));
        }
        let manifest = v.manifest.expect("valid validation has a manifest");
        let dir = target_root.join(&manifest.id);
        if dir.exists() {
            anyhow::bail!("{} already exists", dir.display());
        }
        if cleanup {
            std::fs::rename(&staged, &dir)
                .with_context(|| format!("moving into {}", dir.display()))?;
        } else {
            copy_dir(&staged, &dir)?;
        }
        Ok(Installed {
            id: manifest.id,
            dir,
            warnings: v.warnings,
        })
    })();
    if cleanup && staged.exists() {
        let _ = std::fs::remove_dir_all(&staged);
    }
    result
}

fn copy_dir(from: &Path, to: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(to).with_context(|| format!("creating {}", to.display()))?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if SKIP_DIRS.iter().any(|s| name == *s) {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).with_context(|| format!("copying {}", src.display()))?;
        }
    }
    Ok(())
}

/// Options of [`new_extension`].
#[derive(Clone, Debug)]
pub struct NewOptions {
    /// Version spec of the `@miyoria/sdk` dependency. Inside the monorepo
    /// `workspace:*`; elsewhere a semver range.
    pub sdk: String,
    /// Extension id; defaults to the name.
    pub id: Option<String>,
}

impl Default for NewOptions {
    fn default() -> Self {
        Self {
            sdk: "workspace:*".to_owned(),
            id: None,
        }
    }
}

/// Scaffolds a TypeScript extension in `<parent>/<name>` and returns its
/// directory. `name` must be lowercase letters, digits and `-`.
pub fn new_extension(parent: &Path, name: &str, opts: &NewOptions) -> anyhow::Result<PathBuf> {
    let valid = (1..=32).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-');
    if !valid {
        anyhow::bail!("extension name `{name}` must be 1-32 chars of a-z, 0-9 and `-`");
    }
    let id = opts.id.clone().unwrap_or_else(|| name.to_owned());
    if !crate::manifest::valid_id(&id) {
        anyhow::bail!("invalid extension id `{id}`");
    }
    let dir = parent.join(name);
    if dir.exists() {
        anyhow::bail!("{} already exists", dir.display());
    }
    let tool = format!("{}.echo", name.replace('-', "_"));
    let files: [(&str, String); 6] = [
        (
            MANIFEST_FILE,
            format!(
                r#"id = "{id}"
version = "0.1.0"
name = "{name}"
kind = ["tools", "commands"]
runtime = "node"
entry = "dist/index.js"
placement = "any"

[permissions]
events = []
tools = true
commands = true

[config]
schema = "config.schema.json"
"#
            ),
        ),
        (
            "package.json",
            format!(
                r#"{{
  "name": "miyoria-ext-{name}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {{
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -w -p tsconfig.json"
  }},
  "dependencies": {{
    "@miyoria/sdk": "{sdk}"
  }},
  "devDependencies": {{
    "@types/node": "^24",
    "typescript": "^5.7.2"
  }}
}}
"#,
                sdk = opts.sdk
            ),
        ),
        (
            "tsconfig.json",
            r#"{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
"#
            .to_owned(),
        ),
        (
            "src/index.ts",
            format!(
                r#"import {{ defineExtension }} from "@miyoria/sdk";

export default defineExtension({{
  async activate(ctx) {{
    ctx.tools.register({{
      name: "{tool}",
      description: "把收到的文字原樣回傳",
      params: {{ text: {{ type: "string", description: "要回傳的文字" }} }},
      run: async ({{ text }}) => String(text),
    }});

    ctx.commands.register({{
      path: "{name}",
      description: "跟 {name} 打招呼",
      run: async (inv) => `哈囉,${{inv.invoker_display_name}}!`,
    }});

    ctx.log.info("{name} activated");
  }},
}});
"#
            ),
        ),
        (
            "config.schema.json",
            r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
"#
            .to_owned(),
        ),
        (".gitignore", "node_modules/\ndist/\n".to_owned()),
    ];
    for (path, content) in files {
        let path = dir.join(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, content).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("miyoria-cli-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scaffold_validate_install_list() {
        let root = temp();
        let dir = new_extension(&root.join("src"), "my-ext", &NewOptions::default()).unwrap();
        let v = validate(&dir);
        assert!(v.is_ok(), "{:?}", v.errors);
        assert_eq!(v.manifest.as_ref().unwrap().id, "my-ext");
        // dist is not built yet.
        assert_eq!(v.warnings.len(), 1, "{:?}", v.warnings);
        assert!(new_extension(&root.join("src"), "my-ext", &NewOptions::default()).is_err());
        assert!(new_extension(&root, "Bad", &NewOptions::default()).is_err());

        std::fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        let config = Config::from_toml_str(&format!(
            "[modules.extensions]\ndirs = [{:?}]\n[extensions.\"my-ext\"]\nenabled = false",
            root.join("installed").display().to_string()
        ))
        .unwrap();
        let installed = install(&config, &root, dir.to_str().unwrap()).unwrap();
        assert_eq!(installed.dir, root.join("installed").join("my-ext"));
        assert!(installed.dir.join("src/index.ts").is_file());
        assert!(!installed.dir.join("node_modules").exists());
        assert!(install(&config, &root, dir.to_str().unwrap()).is_err());
        assert!(install(&config, &root, "nope-not-a-dir").is_err());

        let listed = list(&config, &root).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled && listed[0].runs_on_core);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_sources() {
        assert!(is_git_source("https://github.com/a/b"));
        assert!(is_git_source("git@github.com:a/b.git"));
        assert!(is_git_source("git+file:///tmp/x"));
        assert!(!is_git_source("./extensions/x"));
    }

    #[test]
    fn validate_reports_missing_manifest_and_schema() {
        let dir = temp();
        assert!(!validate(&dir).is_ok());
        std::fs::write(
            dir.join(MANIFEST_FILE),
            "id = \"v\"\nversion = \"1\"\nkind = \"tools\"\nruntime = \"node\"\nentry = \"i.js\"\n[config]\nschema = \"missing.json\"",
        )
        .unwrap();
        let v = validate(&dir);
        assert_eq!(v.errors.len(), 1, "{:?}", v.errors);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
