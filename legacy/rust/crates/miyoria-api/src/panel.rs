//! Serves the built admin panel (`apps/panel/dist`) at `/`. Static files
//! never need the bearer token; the panel asks for it and sends it to `/api`.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tower_http::services::ServeDir;
use tracing::warn;

/// Environment variable that overrides `[modules.api] panel_dir`.
pub const PANEL_DIR_ENV: &str = "MIYORIA_PANEL_DIR";

/// Hashed Vite bundles: safe to cache forever.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// `index.html` and unhashed files: always revalidate.
const REVALIDATE: &str = "no-cache";

/// The directory to serve: `env` when set (non-empty), else `configured`.
/// `None` when that is empty or has no `index.html`.
pub(crate) fn pick_dir(env: Option<String>, configured: &str) -> Option<PathBuf> {
    let raw = env
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| configured.trim().to_owned());
    if raw.is_empty() {
        return None;
    }
    let dir = PathBuf::from(raw);
    dir.join("index.html").is_file().then_some(dir)
}

/// Serves one panel file with caching headers.
pub(crate) async fn serve(dir: &Path, request: Request) -> Response {
    let assets = request.uri().path().starts_with("/assets/");
    let mut response = match ServeDir::new(dir).try_call(request).await {
        Ok(response) => response.map(Body::new),
        Err(e) => {
            warn!(error = %e, "cannot serve panel file");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let status = response.status();
    if status.is_success() || status == StatusCode::NOT_MODIFIED {
        let cache = if assets { IMMUTABLE } else { REVALIDATE };
        let headers = response.headers_mut();
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_overrides_config_and_missing_dirs_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        assert_eq!(pick_dir(None, &path), None, "no index.html yet");
        std::fs::write(dir.path().join("index.html"), "<!doctype html>").unwrap();
        assert_eq!(pick_dir(None, &path), Some(dir.path().to_path_buf()));
        assert_eq!(
            pick_dir(Some(String::new()), &path),
            Some(dir.path().to_path_buf())
        );
        assert_eq!(pick_dir(Some("does/not/exist".into()), &path), None);
        assert_eq!(
            pick_dir(Some(path.clone()), "elsewhere"),
            Some(dir.path().to_path_buf())
        );
        assert_eq!(pick_dir(None, ""), None);
    }
}
