//! Discord OAuth2 login for the panel (authorization code + PKCE, scope
//! `identify`) and the `/api/auth/methods|session|logout` routes.
//!
//! Failures redirect to `/#/login?error=<code>` and never carry details:
//! `disabled`, `cancelled`, `state`, `exchange`, `discord`, `denied`,
//! `unavailable`. Details go to the log.

use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, Instant};

use axum::extract::rejection::QueryRejection;
use axum::extract::{Extension, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use miyoria_auth::account_str;
use miyoria_store::SettingsStore;
use miyoria_types::{AccountRef, Authorizer, PlatformId};
use parking_lot::Mutex;
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::server::{ApiError, ApiState};
use crate::session::{PANEL_ACCESS, Principal, cookie_token, has_csrf_header, random_token};
use crate::types::{AuthMethods, SessionInfo, SessionPermissions, SessionUser};

/// How long a started login may take to come back.
const STATE_TTL: Duration = Duration::from_secs(10 * 60);
/// Cap on logins in flight (the login route is public).
const MAX_PENDING: usize = 1024;
const DEFAULT_NEXT: &str = "/#/";
const CDN: &str = "https://cdn.discordapp.com";

/// `[modules.api.discord_oauth]`. Login is on only when `client_id`,
/// `client_secret` and `redirect_uri` are all set.
#[derive(Clone, Deserialize)]
#[serde(default)]
pub struct DiscordOAuthConfig {
    /// The application id (Developer Portal → OAuth2).
    pub client_id: String,
    pub client_secret: String,
    /// Must match a redirect registered in the Developer Portal, e.g.
    /// `http://127.0.0.1:7878/api/auth/oauth/callback`.
    pub redirect_uri: String,
    /// Session lifetime in days (1–365). Default 7.
    pub session_days: u32,
    /// `Secure` cookie flag. Default: on when `redirect_uri` is https.
    pub cookie_secure: Option<bool>,
    /// How long a permission check is reused, in seconds. Default 5.
    pub recheck_secs: u64,
    /// Discord's base URL. Default `https://discord.com` (tests override it).
    pub discord_url: String,
}

impl Default for DiscordOAuthConfig {
    fn default() -> Self {
        Self {
            client_id: String::new(),
            client_secret: String::new(),
            redirect_uri: String::new(),
            session_days: 7,
            cookie_secure: None,
            recheck_secs: 5,
            discord_url: "https://discord.com".to_owned(),
        }
    }
}

impl fmt::Debug for DiscordOAuthConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DiscordOAuthConfig")
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("redirect_uri", &self.redirect_uri)
            .field("session_days", &self.session_days)
            .field("cookie_secure", &self.cookie_secure)
            .field("recheck_secs", &self.recheck_secs)
            .field("discord_url", &self.discord_url)
            .finish()
    }
}

impl DiscordOAuthConfig {
    pub(crate) fn session_ttl(&self) -> chrono::Duration {
        chrono::Duration::days(i64::from(self.session_days.clamp(1, 365)))
    }

    pub(crate) fn recheck(&self) -> Duration {
        Duration::from_secs(self.recheck_secs)
    }
}

struct PendingLogin {
    verifier: String,
    next: String,
    at: Instant,
}

/// Logins between `/login` and `/callback`, by `state`.
#[derive(Default)]
struct Pending(HashMap<String, PendingLogin>);

impl Pending {
    fn insert(&mut self, state: String, login: PendingLogin, now: Instant) {
        self.0
            .retain(|_, p| now.saturating_duration_since(p.at) < STATE_TTL);
        if self.0.len() >= MAX_PENDING
            && let Some(oldest) = self
                .0
                .iter()
                .min_by_key(|(_, p)| p.at)
                .map(|(k, _)| k.clone())
        {
            self.0.remove(&oldest);
        }
        self.0.insert(state, login);
    }

    /// Removes and returns the login for `state` unless it expired.
    fn take(&mut self, state: &str, now: Instant) -> Option<PendingLogin> {
        let login = self.0.remove(state)?;
        (now.saturating_duration_since(login.at) < STATE_TTL).then_some(login)
    }
}

/// A configured Discord OAuth client.
pub(crate) struct OAuth {
    client_id: String,
    client_secret: String,
    redirect_uri: Url,
    discord: Url,
    http: reqwest::Client,
    pending: Mutex<Pending>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct DiscordUser {
    id: String,
    username: String,
    #[serde(default)]
    global_name: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
}

impl DiscordUser {
    fn avatar_url(&self) -> String {
        match &self.avatar {
            Some(hash) if !hash.is_empty() => {
                format!("{CDN}/avatars/{}/{hash}.png?size=64", self.id)
            }
            _ => {
                let index = self.id.parse::<u64>().map_or(0, |id| (id >> 22) % 6);
                format!("{CDN}/embed/avatars/{index}.png")
            }
        }
    }

    fn name(&self) -> String {
        self.global_name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&self.username)
            .to_owned()
    }
}

/// Discord ids are snowflakes.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
}

/// `next` if it is a same-origin relative path (`/…`, not `//…`).
pub(crate) fn safe_next(next: &str) -> Option<&str> {
    let ok = next.starts_with('/')
        && !next.starts_with("//")
        && next.len() <= 512
        && next.bytes().all(|b| b.is_ascii_graphic() && b != b'\\');
    ok.then_some(next)
}

/// base64url(SHA-256(verifier)), the S256 PKCE challenge.
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

impl OAuth {
    /// `None` when login is not configured.
    pub(crate) fn from_config(config: &DiscordOAuthConfig) -> anyhow::Result<Option<Self>> {
        let client_id = config.client_id.trim();
        let client_secret = config.client_secret.trim();
        let redirect_uri = config.redirect_uri.trim();
        let set = [client_id, client_secret, redirect_uri]
            .iter()
            .filter(|s| !s.is_empty())
            .count();
        if set < 3 {
            if set > 0 {
                warn!(
                    "`[modules.api.discord_oauth]` needs client_id, client_secret and \
                     redirect_uri; Discord login stays off"
                );
            }
            return Ok(None);
        }
        let redirect = Url::parse(redirect_uri)
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https"))
            .ok_or_else(|| {
                anyhow::anyhow!("`[modules.api.discord_oauth] redirect_uri` is not an http(s) URL")
            })?;
        if !redirect.path().ends_with("/api/auth/oauth/callback") {
            warn!(%redirect, "discord_oauth redirect_uri should end in /api/auth/oauth/callback");
        }
        let mut discord = Url::parse(config.discord_url.trim())
            .ok()
            .filter(|u| !u.cannot_be_a_base())
            .ok_or_else(|| {
                anyhow::anyhow!("`[modules.api.discord_oauth] discord_url` is not a URL")
            })?;
        if !discord.path().ends_with('/') {
            let path = format!("{}/", discord.path());
            discord.set_path(&path);
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Some(Self {
            client_id: client_id.to_owned(),
            client_secret: client_secret.to_owned(),
            redirect_uri: redirect,
            discord,
            http,
            pending: Mutex::new(Pending::default()),
        }))
    }

    pub(crate) fn redirect_is_https(&self) -> bool {
        self.redirect_uri.scheme() == "https"
    }

    fn endpoint(&self, path: &str) -> Url {
        self.discord.join(path).expect("static endpoint paths join")
    }

    /// Starts a login: remembers `state` and the PKCE verifier, returns the
    /// Discord authorize URL.
    fn begin(&self, next: String) -> Url {
        let state = random_token(32);
        let verifier = random_token(32);
        let challenge = pkce_challenge(&verifier);
        let now = Instant::now();
        self.pending.lock().insert(
            state.clone(),
            PendingLogin {
                verifier,
                next,
                at: now,
            },
            now,
        );
        let mut url = self.endpoint("oauth2/authorize");
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.client_id)
            .append_pair("scope", "identify")
            .append_pair("redirect_uri", self.redirect_uri.as_str())
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("prompt", "none");
        url
    }

    /// Exchanges the code and fetches the user, or names what failed.
    async fn fetch_user(&self, code: &str, verifier: &str) -> Result<DiscordUser, &'static str> {
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", self.redirect_uri.as_str()),
            ("code_verifier", verifier),
            ("client_id", &self.client_id),
            ("client_secret", &self.client_secret),
        ];
        let token: TokenResponse = async {
            self.http
                .post(self.endpoint("api/oauth2/token"))
                .form(&form)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await
        }
        .await
        .map_err(|e| {
            warn!(error = %e, "Discord OAuth code exchange failed");
            "exchange"
        })?;
        let user: DiscordUser = async {
            self.http
                .get(self.endpoint("api/users/@me"))
                .bearer_auth(&token.access_token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await
        }
        .await
        .map_err(|e| {
            warn!(error = %e, "cannot fetch the Discord user");
            "discord"
        })?;
        if !valid_id(&user.id) {
            warn!(id = %user.id, "Discord returned an invalid user id");
            return Err("discord");
        }
        Ok(user)
    }
}

pub(crate) fn public_routes() -> Router<ApiState> {
    Router::new()
        .route("/api/auth/methods", get(methods))
        .route("/api/auth/oauth/login", get(login))
        .route("/api/auth/oauth/callback", get(callback))
        .route("/api/auth/logout", post(logout))
}

pub(crate) fn protected_routes() -> Router<ApiState> {
    Router::new().route("/api/auth/session", get(session))
}

/// A `302 Found` that is never cached or leaks the callback URL.
fn found(location: &str, cookie: Option<HeaderValue>) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    let headers = response.headers_mut();
    match HeaderValue::from_str(location) {
        Ok(v) => headers.insert(header::LOCATION, v),
        Err(_) => headers.insert(header::LOCATION, HeaderValue::from_static(DEFAULT_NEXT)),
    };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if let Some(cookie) = cookie {
        headers.insert(header::SET_COOKIE, cookie);
    }
    response
}

fn login_error(code: &str) -> Response {
    found(&format!("/#/login?error={code}"), None)
}

async fn methods(State(state): State<ApiState>) -> Json<AuthMethods> {
    Json(AuthMethods {
        token: true,
        discord: state.auth.oauth.is_some(),
    })
}

#[derive(Deserialize)]
struct LoginQuery {
    next: Option<String>,
}

async fn login(
    State(state): State<ApiState>,
    q: Result<Query<LoginQuery>, QueryRejection>,
) -> Response {
    let Some(oauth) = &state.auth.oauth else {
        return login_error("disabled");
    };
    let next = q
        .ok()
        .and_then(|Query(q)| q.next)
        .filter(|n| safe_next(n).is_some())
        .unwrap_or_else(|| DEFAULT_NEXT.to_owned());
    found(oauth.begin(next).as_str(), None)
}

#[derive(Default, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback(
    State(state): State<ApiState>,
    q: Result<Query<CallbackQuery>, QueryRejection>,
) -> Response {
    let Some(oauth) = &state.auth.oauth else {
        return login_error("disabled");
    };
    let q = q.map(|Query(q)| q).unwrap_or_default();
    let pending = q
        .state
        .as_deref()
        .and_then(|s| oauth.pending.lock().take(s, Instant::now()));
    if q.error.is_some() {
        return login_error("cancelled");
    }
    let Some(pending) = pending else {
        return login_error("state");
    };
    let Some(code) = q.code.as_deref().filter(|c| !c.is_empty()) else {
        return login_error("exchange");
    };
    let user = match oauth.fetch_user(code, &pending.verifier).await {
        Ok(user) => user,
        Err(code) => return login_error(code),
    };
    let account = AccountRef {
        platform: PlatformId::new("discord"),
        id: user.id.clone(),
    };
    let actor = account_str(&account);
    let Some(authorizer) = state.optional::<dyn Authorizer>() else {
        warn!(account = %actor, "no authorizer service; refusing panel login");
        return login_error("unavailable");
    };
    if !authorizer.allows(&account, PANEL_ACCESS) {
        info!(account = %actor, "panel login denied: no `{PANEL_ACCESS}`");
        state
            .audit_as(&actor, "panel.login", &actor, serde_json::json!({}), false)
            .await;
        return login_error("denied");
    }
    let store = state.optional::<dyn SettingsStore>();
    let name = user.name();
    let token = state
        .auth
        .sessions
        .create(
            store.as_deref(),
            account,
            name.clone(),
            Some(user.avatar_url()),
        )
        .await;
    info!(account = %actor, %name, "panel login");
    state
        .audit_as(
            &actor,
            "panel.login",
            &actor,
            serde_json::json!({ "name": name }),
            true,
        )
        .await;
    found(&pending.next, Some(state.auth.session_cookie(&token)))
}

async fn session(Extension(principal): Extension<Principal>) -> Json<SessionInfo> {
    Json(match principal {
        Principal::Token => SessionInfo {
            method: "token".to_owned(),
            user: None,
            permissions: SessionPermissions { write: true },
        },
        Principal::Session { record, write } => SessionInfo {
            method: "discord".to_owned(),
            user: Some(SessionUser {
                id: record.account.id,
                name: record.name,
                avatar_url: record.avatar_url,
            }),
            permissions: SessionPermissions { write },
        },
    })
}

async fn logout(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_token(&headers) {
        if !has_csrf_header(&headers) {
            return ApiError::new(
                StatusCode::FORBIDDEN,
                "missing the `x-miyoria-request: 1` header",
            )
            .into_response();
        }
        let store = state.optional::<dyn SettingsStore>();
        state.auth.sessions.remove(store.as_deref(), token).await;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, state.auth.clear_cookie());
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(at: Instant) -> PendingLogin {
        PendingLogin {
            verifier: "v".into(),
            next: "/".into(),
            at,
        }
    }

    #[test]
    fn states_expire_and_are_single_use() {
        let mut pending = Pending::default();
        let t0 = Instant::now();
        pending.insert("a".into(), login(t0), t0);
        pending.insert("b".into(), login(t0), t0);
        assert!(pending.take("a", t0 + Duration::from_secs(60)).is_some());
        assert!(
            pending.take("a", t0 + Duration::from_secs(61)).is_none(),
            "used"
        );
        assert!(pending.take("b", t0 + STATE_TTL).is_none(), "expired");
        assert!(pending.take("nope", t0).is_none());
    }

    #[test]
    fn pending_logins_are_capped() {
        let mut pending = Pending::default();
        let t0 = Instant::now();
        for i in 0..MAX_PENDING + 5 {
            let at = t0 + Duration::from_millis(i as u64);
            pending.insert(i.to_string(), login(at), at);
        }
        assert_eq!(pending.0.len(), MAX_PENDING);
        assert!(!pending.0.contains_key("0"), "the oldest went first");
    }

    #[test]
    fn next_must_be_a_local_path() {
        for ok in ["/", "/#/", "/#/people?q=1", "/#/login"] {
            assert_eq!(safe_next(ok), Some(ok), "{ok}");
        }
        for bad in [
            "",
            "//evil.example",
            "/\\evil.example",
            "https://evil.example",
            "javascript:alert(1)",
            "/a b",
            "/\r\nSet-Cookie:x",
            "/人",
        ] {
            assert_eq!(safe_next(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn pkce_challenge_matches_rfc_7636() {
        // RFC 7636 appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn avatar_and_name_fallbacks() {
        let user = DiscordUser {
            id: "80351110224678912".into(),
            username: "nelly".into(),
            global_name: Some(" ".into()),
            avatar: None,
        };
        assert_eq!(user.name(), "nelly");
        assert!(
            user.avatar_url()
                .starts_with(&format!("{CDN}/embed/avatars/"))
        );
        let user = DiscordUser {
            avatar: Some("abc".into()),
            global_name: Some("Nelly".into()),
            ..user
        };
        assert_eq!(user.name(), "Nelly");
        assert_eq!(
            user.avatar_url(),
            format!("{CDN}/avatars/80351110224678912/abc.png?size=64")
        );
        assert!(valid_id("123") && !valid_id("12a") && !valid_id(""));
    }
}
