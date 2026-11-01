//! Helpers shared by the HTTP-based providers.

use anyhow::Context;
use reqwest::Response;
use reqwest::header::{self, HeaderMap, HeaderValue};
use serde::de::DeserializeOwned;

use crate::ProviderConfig;

/// Deserializes a provider's free-form settings into its typed config.
pub(crate) fn parse_settings<T: DeserializeOwned>(config: &ProviderConfig) -> anyhow::Result<T> {
    serde_json::from_value(serde_json::Value::Object(config.settings.clone()))
        .context("invalid provider settings")
}

/// `{base}/{path}` without doubled slashes.
pub(crate) fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Default headers carrying an optional (sensitive) bearer token.
pub(crate) fn bearer_headers(api_key: Option<&str>) -> anyhow::Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        let mut value = HeaderValue::from_str(&format!("Bearer {}", key.trim()))
            .map_err(|_| anyhow::anyhow!("API key contains invalid characters"))?;
        value.set_sensitive(true);
        headers.insert(header::AUTHORIZATION, value);
    }
    Ok(headers)
}

/// Passes 2xx responses through; turns anything else into an error carrying
/// the server's message (`{"error":"..."}` or `{"error":{"message":"..."}}`).
pub(crate) async fn ensure_ok(resp: Response) -> anyhow::Result<Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            let e = v.get("error")?;
            e.as_str()
                .or_else(|| e.get("message")?.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    anyhow::bail!("HTTP {status}: {detail}")
}
