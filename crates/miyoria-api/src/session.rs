//! Panel login: the static bearer token or a Discord OAuth session cookie.
//!
//! Session tokens are 256 random bits; only their SHA-256 hash is kept, in
//! memory and (when there is a `dyn SettingsStore`) under profile `_global`,
//! key `panel_session:<hash>`, so sessions survive a restart. Every request
//! re-checks `admin.panel.access` (cached for `recheck_secs`), so revoking a
//! role takes effect without logging anyone out by hand.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use miyoria_auth::account_str;
use miyoria_store::SettingsStore;
use miyoria_types::{AccountRef, Authorizer, ProfileId};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tracing::warn;

use crate::oauth::OAuth;
use crate::server::{ApiError, ApiState};

/// Name of the session cookie.
pub(crate) const COOKIE: &str = "miyoria_session";
/// Header cookie-authenticated changes must carry (value `1`). A cross-site
/// form or link cannot set it, which makes it a CSRF guard.
pub(crate) const CSRF_HEADER: &str = "x-miyoria-request";
/// Lets OAuth users into the panel at all.
pub(crate) const PANEL_ACCESS: &str = miyoria_auth::builtin::PANEL_ACCESS;
/// Lets OAuth users change things (every non-GET route).
pub(crate) const PANEL_WRITE: &str = miyoria_auth::builtin::PANEL_WRITE;

/// Settings profile and key prefix of persisted sessions.
const STORE_PROFILE: &str = "_global";
const STORE_PREFIX: &str = "panel_session:";
/// Length of a base64url-encoded 32-byte token.
const TOKEN_LEN: usize = 43;

tokio::task_local! {
    static ACTOR: String;
}

/// Actor of the current request for audit entries: `"api"` for the bearer
/// token, the account (`discord:<id>`) for an OAuth session.
pub(crate) fn actor() -> String {
    ACTOR
        .try_with(Clone::clone)
        .unwrap_or_else(|_| crate::server::ACTOR.to_owned())
}

/// `n` random bytes from the OS, base64url without padding.
pub(crate) fn random_token(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).expect("the OS random number generator works");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Lowercase hex SHA-256.
pub(crate) fn sha256_hex(data: &str) -> String {
    Sha256::digest(data.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn looks_like_token(token: &str) -> bool {
    token.len() == TOKEN_LEN
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A logged-in panel user, as persisted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SessionRecord {
    pub(crate) account: AccountRef,
    pub(crate) name: String,
    pub(crate) avatar_url: Option<String>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) expires_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Access {
    pub(crate) panel: bool,
    pub(crate) write: bool,
}

impl Access {
    fn check(authorizer: Option<&dyn Authorizer>, account: &AccountRef) -> Self {
        // Without an authorizer nobody but the bearer token gets in.
        let Some(authorizer) = authorizer else {
            return Self {
                panel: false,
                write: false,
            };
        };
        let panel = authorizer.allows(account, PANEL_ACCESS);
        Self {
            panel,
            write: panel && authorizer.allows(account, PANEL_WRITE),
        }
    }
}

struct Entry {
    record: SessionRecord,
    checked: Option<(Instant, Access)>,
}

/// Who made a protected request; inserted as a request extension.
#[derive(Clone, Debug)]
pub(crate) enum Principal {
    Token,
    Session { record: SessionRecord, write: bool },
}

impl Principal {
    fn actor(&self) -> String {
        match self {
            Self::Token => crate::server::ACTOR.to_owned(),
            Self::Session { record, .. } => account_str(&record.account),
        }
    }
}

/// Live sessions by token hash.
pub(crate) struct Sessions {
    map: Mutex<HashMap<String, Entry>>,
    ttl: chrono::Duration,
    recheck: Duration,
}

fn store_key(hash: &str) -> String {
    format!("{STORE_PREFIX}{hash}")
}

fn store_profile() -> ProfileId {
    ProfileId::from(STORE_PROFILE)
}

impl Sessions {
    pub(crate) fn new(ttl: chrono::Duration, recheck: Duration) -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            ttl,
            recheck,
        }
    }

    pub(crate) fn ttl(&self) -> chrono::Duration {
        self.ttl
    }

    /// Starts a session and returns its token (the cookie value).
    pub(crate) async fn create(
        &self,
        store: Option<&dyn SettingsStore>,
        account: AccountRef,
        name: String,
        avatar_url: Option<String>,
    ) -> String {
        let token = random_token(32);
        let hash = sha256_hex(&token);
        let now = Utc::now();
        let record = SessionRecord {
            account,
            name,
            avatar_url,
            created_at: now,
            expires_at: now + self.ttl,
        };
        if let Some(store) = store {
            let value = serde_json::to_value(&record).expect("session record serializes");
            if let Err(e) = store
                .set(&store_profile(), &store_key(&hash), Some(value))
                .await
            {
                warn!(error = %format!("{e:#}"), "cannot persist panel session; it lasts until restart");
            }
        }
        self.map.lock().insert(
            hash,
            Entry {
                record,
                checked: None,
            },
        );
        token
    }

    /// The live session for `token` and what it may do now.
    pub(crate) async fn lookup(
        &self,
        store: Option<&dyn SettingsStore>,
        authorizer: Option<&dyn Authorizer>,
        token: &str,
    ) -> Option<(SessionRecord, Access)> {
        if !looks_like_token(token) {
            return None;
        }
        let hash = sha256_hex(token);
        let now = Utc::now();
        let cached = {
            let mut map = self.map.lock();
            match map.get(&hash) {
                Some(e) if e.record.expires_at <= now => {
                    map.remove(&hash);
                    None
                }
                Some(e) => Some((e.record.clone(), e.checked)),
                None => None,
            }
        };
        let (record, checked) = match cached {
            Some(found) => found,
            None => (self.load(store, &hash, now).await?, None),
        };
        let fresh = checked.filter(|(at, _)| at.elapsed() < self.recheck);
        let access = match fresh {
            Some((_, access)) => access,
            None => {
                let access = Access::check(authorizer, &record.account);
                if let Some(e) = self.map.lock().get_mut(&hash) {
                    e.checked = Some((Instant::now(), access));
                }
                access
            }
        };
        Some((record, access))
    }

    /// Reads a session another run of this module persisted.
    async fn load(
        &self,
        store: Option<&dyn SettingsStore>,
        hash: &str,
        now: DateTime<Utc>,
    ) -> Option<SessionRecord> {
        let store = store?;
        let key = store_key(hash);
        let value = match store.get(&store_profile(), &key).await {
            Ok(v) => v?,
            Err(e) => {
                warn!(error = %format!("{e:#}"), "cannot read panel session");
                return None;
            }
        };
        let record = serde_json::from_value::<SessionRecord>(value)
            .ok()
            .filter(|r| r.expires_at > now);
        let Some(record) = record else {
            if let Err(e) = store.set(&store_profile(), &key, None).await {
                warn!(error = %format!("{e:#}"), "cannot delete expired panel session");
            }
            return None;
        };
        self.map.lock().insert(
            hash.to_owned(),
            Entry {
                record: record.clone(),
                checked: None,
            },
        );
        Some(record)
    }

    /// Ends the session for `token`, if any.
    pub(crate) async fn remove(&self, store: Option<&dyn SettingsStore>, token: &str) {
        if !looks_like_token(token) {
            return;
        }
        let hash = sha256_hex(token);
        self.map.lock().remove(&hash);
        if let Some(store) = store
            && let Err(e) = store.set(&store_profile(), &store_key(&hash), None).await
        {
            warn!(error = %format!("{e:#}"), "cannot delete panel session");
        }
    }

    /// Drops expired sessions from memory and the store.
    pub(crate) async fn prune(&self, store: Option<&dyn SettingsStore>) {
        let now = Utc::now();
        self.map.lock().retain(|_, e| e.record.expires_at > now);
        let Some(store) = store else {
            return;
        };
        let profile = store_profile();
        let all = match store.list(&profile, STORE_PREFIX).await {
            Ok(all) => all,
            Err(e) => {
                warn!(error = %format!("{e:#}"), "cannot list panel sessions");
                return;
            }
        };
        for (key, value) in all {
            let live =
                serde_json::from_value::<SessionRecord>(value).is_ok_and(|r| r.expires_at > now);
            if !live && let Err(e) = store.set(&profile, &key, None).await {
                warn!(error = %format!("{e:#}"), "cannot delete expired panel session");
            }
        }
    }
}

/// Everything the auth middleware and the login routes share.
pub(crate) struct PanelAuth {
    token: Box<[u8]>,
    pub(crate) sessions: Sessions,
    pub(crate) oauth: Option<OAuth>,
    cookie_secure: bool,
}

impl PanelAuth {
    pub(crate) fn new(
        token: &str,
        sessions: Sessions,
        oauth: Option<OAuth>,
        cookie_secure: bool,
    ) -> Self {
        Self {
            token: token.as_bytes().into(),
            sessions,
            oauth,
            cookie_secure,
        }
    }

    fn token_matches(&self, presented: &str) -> bool {
        bool::from(presented.trim().as_bytes().ct_eq(&self.token))
    }

    /// `Set-Cookie` value starting a session.
    pub(crate) fn session_cookie(&self, token: &str) -> HeaderValue {
        let max_age = self.sessions.ttl().num_seconds().max(0);
        self.cookie(&format!("{COOKIE}={token}; Max-Age={max_age}"))
    }

    /// `Set-Cookie` value deleting the session cookie.
    pub(crate) fn clear_cookie(&self) -> HeaderValue {
        self.cookie(&format!("{COOKIE}=; Max-Age=0"))
    }

    fn cookie(&self, start: &str) -> HeaderValue {
        let secure = if self.cookie_secure { "; Secure" } else { "" };
        HeaderValue::from_str(&format!("{start}; Path=/; HttpOnly; SameSite=Lax{secure}"))
            .expect("cookie values are ASCII")
    }
}

/// The session cookie's value, if the request has one.
pub(crate) fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE)
        .map(|(_, value)| value.trim())
        .filter(|v| !v.is_empty())
}

/// Did the request carry the CSRF guard header?
pub(crate) fn has_csrf_header(headers: &HeaderMap) -> bool {
    headers
        .get(CSRF_HEADER)
        .is_some_and(|v| v.as_bytes() == b"1")
}

fn is_safe(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

fn unauthorized(message: &str) -> Response {
    ApiError::new(StatusCode::UNAUTHORIZED, message).into_response()
}

/// Accepts the bearer token or (with Discord login configured) a session
/// cookie. An `Authorization` header, when present, must be the token;
/// cookies are not consulted then.
pub(crate) async fn require_auth(
    State(state): State<ApiState>,
    mut request: Request,
    next: Next,
) -> Response {
    let auth = state.auth.clone();
    let headers = request.headers();
    let principal = if let Some(value) = headers.get(header::AUTHORIZATION) {
        let ok = value
            .to_str()
            .ok()
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|t| auth.token_matches(t));
        if !ok {
            return unauthorized("missing or invalid bearer token");
        }
        Principal::Token
    } else if auth.oauth.is_some()
        && let Some(token) = cookie_token(headers)
    {
        // Sessions only count while Discord login is configured.
        let store = state.optional::<dyn SettingsStore>();
        let authorizer = state.optional::<dyn Authorizer>();
        let Some((record, access)) = auth
            .sessions
            .lookup(store.as_deref(), authorizer.as_deref(), token)
            .await
        else {
            return unauthorized("session expired or invalid");
        };
        if !access.panel {
            return unauthorized("this account no longer has panel access");
        }
        if !is_safe(request.method()) {
            if !has_csrf_header(request.headers()) {
                return ApiError::new(
                    StatusCode::FORBIDDEN,
                    format!("cookie-authenticated changes need the `{CSRF_HEADER}: 1` header"),
                )
                .into_response();
            }
            if !access.write {
                return ApiError::new(
                    StatusCode::FORBIDDEN,
                    format!("this account may only look (changes need `{PANEL_WRITE}`)"),
                )
                .into_response();
            }
        }
        Principal::Session {
            record,
            write: access.write,
        }
    } else {
        return unauthorized("missing or invalid bearer token");
    };
    let actor = principal.actor();
    request.extensions_mut().insert(principal);
    ACTOR.scope(actor, next.run(request)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use miyoria_types::PlatformId;

    fn account() -> AccountRef {
        AccountRef {
            platform: PlatformId::new("discord"),
            id: "1".into(),
        }
    }

    struct Allow(bool, bool);

    impl Authorizer for Allow {
        fn allows_subject(&self, _: &miyoria_types::Subject, node: &str) -> bool {
            match node {
                PANEL_ACCESS => self.0,
                PANEL_WRITE => self.1,
                _ => false,
            }
        }
    }

    #[test]
    fn tokens_are_random_and_hashes_are_hex() {
        let a = random_token(32);
        assert_eq!(a.len(), TOKEN_LEN);
        assert!(looks_like_token(&a));
        assert_ne!(a, random_token(32));
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(!looks_like_token("short"));
        assert!(!looks_like_token(&format!("{}!", &a[..42])));
    }

    #[test]
    fn parses_the_session_cookie() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, HeaderValue::from_static("a=b; other=1"));
        assert_eq!(cookie_token(&headers), None);
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("x=y;  miyoria_session=tok ; z=1"),
        );
        assert_eq!(cookie_token(&headers), Some("tok"));
    }

    #[tokio::test]
    async fn expired_sessions_are_gone_and_checks_are_cached() {
        let sessions = Sessions::new(chrono::Duration::days(1), Duration::from_secs(60));
        let token = sessions.create(None, account(), "A".into(), None).await;
        let found = sessions
            .lookup(None, Some(&Allow(true, false)), &token)
            .await
            .unwrap();
        assert_eq!(
            found.1,
            Access {
                panel: true,
                write: false
            }
        );
        // Cached: a changed authorizer is not consulted until `recheck` passes.
        let again = sessions
            .lookup(None, Some(&Allow(false, false)), &token)
            .await
            .unwrap();
        assert!(again.1.panel);

        let expired = Sessions::new(chrono::Duration::seconds(-1), Duration::ZERO);
        let token = expired.create(None, account(), "A".into(), None).await;
        assert!(
            expired
                .lookup(None, Some(&Allow(true, true)), &token)
                .await
                .is_none()
        );
        assert!(expired.map.lock().is_empty());
    }

    #[test]
    fn no_authorizer_means_no_access() {
        let access = Access::check(None, &account());
        assert!(!access.panel && !access.write);
        assert!(!Access::check(Some(&Allow(false, true)), &account()).write);
    }
}
