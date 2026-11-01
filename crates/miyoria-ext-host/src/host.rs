//! Discovery and the `extensions` host module.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use miyoria_kernel::{Config, Module, ModuleContext, ModuleManifest, SupervisorHandle};
use miyoria_types::ModuleId;
use tracing::{info, warn};

use crate::config::{ExtensionSettings, HostConfig};
use crate::extension::{ExtensionModule, ExtensionSpec};
use crate::manifest::{ExtensionManifest, MANIFEST_FILE, McpServerSpec};
use crate::watch::{SKIP_DIRS, Snapshot, snapshot, watch_roots};

/// A module for the app to register with the supervisor.
pub struct DiscoveredModule {
    pub module: Arc<dyn Module>,
    /// Config section to pass to `Supervisor::register`.
    pub config: serde_json::Value,
    pub enabled: bool,
}

/// Result of [`discover`]: the `extensions` host module first, then one
/// `ext.<id>` module per runnable extension.
pub struct Discovery {
    pub modules: Vec<DiscoveredModule>,
    /// Extensions that were skipped, with the reason (invalid manifest,
    /// duplicate id, stage-only placement, ...).
    pub skipped: Vec<(PathBuf, String)>,
}

/// One extension known to the host, provided as part of [`ExtensionCatalog`].
#[derive(Clone, Debug)]
pub struct CatalogEntry {
    pub spec: ExtensionSpec,
    pub enabled: bool,
}

/// Every extension the core runs. Provided as the service
/// `Arc<ExtensionCatalog>` by the `extensions` module (e.g. for the MCP
/// module to pick up bundled MCP servers, or for the panel).
#[derive(Clone, Debug, Default)]
pub struct ExtensionCatalog {
    pub entries: Vec<CatalogEntry>,
}

impl ExtensionCatalog {
    /// Bundled MCP servers of enabled extensions: (extension id, dir, spec).
    pub fn mcp_servers(&self) -> impl Iterator<Item = (&str, &Path, &McpServerSpec)> {
        self.entries.iter().filter(|e| e.enabled).flat_map(|e| {
            e.spec
                .manifest
                .mcp_servers
                .iter()
                .map(|s| (e.spec.manifest.id.as_str(), e.spec.dir.as_path(), s))
        })
    }
}

/// Finds extension directories under `root`: `root` itself if it holds a
/// manifest, otherwise its subdirectories (up to three levels deep).
pub fn find_extension_dirs(root: &Path) -> Vec<PathBuf> {
    fn visit(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if dir.join(MANIFEST_FILE).is_file() {
            out.push(dir.to_path_buf());
            return;
        }
        if depth == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut children: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref()) && name != "dist"
            })
            .map(|e| e.path())
            .collect();
        children.sort();
        for child in children {
            visit(&child, depth - 1, out);
        }
    }
    let mut out = Vec::new();
    visit(root, 3, &mut out);
    out
}

/// Discovers extensions in `[modules.extensions] dirs`, resolved against the
/// working directory.
pub fn discover(config: &Config) -> anyhow::Result<Discovery> {
    discover_in(config, &std::env::current_dir()?)
}

/// Like [`discover`], resolving relative dirs against `base`.
pub fn discover_in(config: &Config, base: &Path) -> anyhow::Result<Discovery> {
    let host = Arc::new(HostConfig::from_config(config)?);
    let (host_enabled, host_section) = config.module(ExtensionsModule::ID);
    let mut skipped = Vec::new();
    let mut catalog = Vec::new();
    let mut modules = Vec::new();

    for root in host.resolved_dirs(base) {
        for dir in find_extension_dirs(&root) {
            let manifest = match ExtensionManifest::load(&dir) {
                Ok(m) => m,
                Err(e) => {
                    skipped.push((dir, e.to_string()));
                    continue;
                }
            };
            let errors = manifest.errors();
            if !errors.is_empty() {
                skipped.push((dir, errors.join("; ")));
                continue;
            }
            if !manifest.placement.runs_on_core() {
                skipped.push((dir, "placement `stage`: runs on the stage node".to_owned()));
                continue;
            }
            if catalog
                .iter()
                .any(|e: &CatalogEntry| e.spec.manifest.id == manifest.id)
            {
                skipped.push((dir, format!("duplicate extension id `{}`", manifest.id)));
                continue;
            }
            let settings = ExtensionSettings::from_config(config, &manifest.id)?;
            let schema = manifest.config.schema.as_ref().and_then(|file| {
                let path = dir.join(file);
                match std::fs::read_to_string(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
                {
                    Ok(v) => Some(v),
                    Err(e) => {
                        warn!(path = %path.display(), error = %e, "unreadable config schema");
                        None
                    }
                }
            });
            let enabled = settings.enabled.unwrap_or(true);
            let spec = ExtensionSpec {
                granted: settings.granted(&manifest.permissions),
                manifest,
                dir,
            };
            catalog.push(CatalogEntry {
                spec: spec.clone(),
                enabled,
            });
            modules.push(DiscoveredModule {
                module: Arc::new(ExtensionModule::new(spec, host.clone(), schema)),
                config: settings.config,
                enabled,
            });
        }
    }

    let host_module = DiscoveredModule {
        module: Arc::new(ExtensionsModule::new(ExtensionCatalog { entries: catalog })),
        config: host_section,
        enabled: host_enabled,
    };
    modules.insert(0, host_module);
    Ok(Discovery { modules, skipped })
}

/// Module `extensions`: provides [`ExtensionCatalog`] and, with
/// `dev = true`, restarts `ext.<id>` modules whose files changed.
pub struct ExtensionsModule {
    manifest: ModuleManifest,
    catalog: Arc<ExtensionCatalog>,
}

impl ExtensionsModule {
    pub const ID: &'static str = "extensions";

    pub fn new(catalog: ExtensionCatalog) -> Self {
        Self {
            manifest: ModuleManifest::new(Self::ID, "Extensions")
                .description("Runs out-of-process extensions over JSON-RPC"),
            catalog: Arc::new(catalog),
        }
    }
}

#[async_trait]
impl Module for ExtensionsModule {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    async fn start(&self, ctx: ModuleContext) -> anyhow::Result<()> {
        let host: HostConfig = ctx.config()?;
        ctx.provide(self.catalog.clone());
        if host.dev {
            let targets: Vec<(ModuleId, Vec<PathBuf>)> = self
                .catalog
                .entries
                .iter()
                .map(|e| {
                    (
                        e.spec.module_id(),
                        watch_roots(&e.spec.dir, &e.spec.manifest),
                    )
                })
                .collect();
            info!(
                extensions = targets.len(),
                "dev mode: watching extension files"
            );
            let poll = Duration::from_millis(host.watch_poll_ms.max(50));
            ctx.spawn("watch", watch_loop(ctx.clone(), targets, poll));
        }
        Ok(())
    }
}

async fn watch_loop(
    ctx: ModuleContext,
    targets: Vec<(ModuleId, Vec<PathBuf>)>,
    poll: Duration,
) -> anyhow::Result<()> {
    let take = |targets: Vec<(ModuleId, Vec<PathBuf>)>| async move {
        tokio::task::spawn_blocking(move || {
            let snaps: Vec<Snapshot> = targets.iter().map(|(_, r)| snapshot(r)).collect();
            (targets, snaps)
        })
        .await
        .expect("snapshot task panicked")
    };
    let (mut targets, mut snaps) = take(targets).await;
    let mut dirty = vec![false; targets.len()];
    loop {
        tokio::select! {
            () = tokio::time::sleep(poll) => {}
            () = ctx.cancellation().cancelled() => return Ok(()),
        }
        let (t, now) = take(targets).await;
        targets = t;
        for (i, snap) in now.into_iter().enumerate() {
            if snap != snaps[i] {
                // Wait for one quiet poll so a build finishes writing.
                snaps[i] = snap;
                dirty[i] = true;
            } else if dirty[i] {
                dirty[i] = false;
                restart(&ctx, &targets[i].0).await;
            }
        }
    }
}

async fn restart(ctx: &ModuleContext, id: &ModuleId) {
    let Some(sup) = ctx.services().get::<SupervisorHandle>() else {
        warn!(module = %id, "files changed but no supervisor handle is available");
        return;
    };
    let enabled = sup.list().await.iter().any(|s| &s.id == id && s.enabled);
    if !enabled {
        return;
    }
    info!(module = %id, "extension files changed; restarting");
    if let Err(e) = sup.restart(id).await {
        warn!(module = %id, error = %e, "restart after file change failed");
    }
}
