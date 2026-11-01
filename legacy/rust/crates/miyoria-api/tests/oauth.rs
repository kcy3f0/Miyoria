//! Discord OAuth login for the panel against a fake Discord: the full
//! login → callback → cookie → session flow, PKCE, state handling, open
//! redirects, CSRF, write permission, logout, expiry, revocation and
//! session persistence.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Form, State};
use axum::http::{HeaderMap, StatusCode as AxumStatus};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Utc;
use miyoria_api::{ApiClient, ApiModule};
use miyoria_auth::AuthService;
use miyoria_kernel::{EventBus, ServiceRegistry, Supervisor, SupervisorHandle};
use miyoria_queue::{QueueConfig, RequestQueue};
use miyoria_store::{
    AuditEntry, AuditLog, AuthScope, AuthStore, RoleDefinition, SettingsStore, Store,
};
use miyoria_types::{AccountRef, Authorizer, ModuleId, PlatformId, ProfileId};
use parking_lot::Mutex;
use reqwest::{Method, StatusCode, Url, header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const TOKEN: &str = "test-token";
const OWNER: &str = "111";
const STRANGER: &str = "222";
const VIEWER: &str = "333";
const ADMIN: &str = "444";
const REDIRECT: &str = "http://panel.test/api/auth/oauth/callback";

/// Codes the fake Discord accepts, as `code → (id, username, global_name)`.
fn users() -> HashMap<&'static str, (&'static str, &'static str, Option<&'static str>)> {
    HashMap::from([
        ("owner-code", (OWNER, "owner", Some("Owner Name"))),
        ("stranger-code", (STRANGER, "stranger", None)),
        ("viewer-code", (VIEWER, "viewer", None)),
        ("admin-code", (ADMIN, "admin", None)),
    ])
}

#[derive(Default)]
struct FakeDiscord {
    /// Every form posted to the token endpoint.
    token_requests: Mutex<Vec<HashMap<String, String>>>,
}

async fn fake_token(
    State(fake): State<Arc<FakeDiscord>>,
    Form(form): Form<HashMap<String, String>>,
) -> (AxumStatus, Json<Value>) {
    fake.token_requests.lock().push(form.clone());
    let get = |k: &str| form.get(k).map(String::as_str).unwrap_or_default();
    let ok = get("grant_type") == "authorization_code"
        && get("client_id") == "cid"
        && get("client_secret") == "secret"
        && get("redirect_uri") == REDIRECT
        && !get("code_verifier").is_empty()
        && users().contains_key(get("code"));
    if ok {
        let token = format!("at-{}", get("code"));
        (
            AxumStatus::OK,
            Json(json!({ "access_token": token, "token_type": "Bearer", "expires_in": 604800 })),
        )
    } else {
        (
            AxumStatus::BAD_REQUEST,
            Json(json!({ "error": "invalid_grant" })),
        )
    }
}

async fn fake_me(headers: HeaderMap) -> (AxumStatus, Json<Value>) {
    let code = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer at-"))
        .unwrap_or_default()
        .to_owned();
    match users().get(code.as_str()) {
        Some((id, username, global_name)) => (
            AxumStatus::OK,
            Json(json!({
                "id": id, "username": username, "global_name": global_name,
                "avatar": if *id == OWNER { Value::from("abc123") } else { Value::Null },
            })),
        ),
        None => (
            AxumStatus::UNAUTHORIZED,
            Json(json!({ "message": "401: Unauthorized" })),
        ),
    }
}

async fn start_fake() -> (String, Arc<FakeDiscord>) {
    let fake = Arc::new(FakeDiscord::default());
    let app = Router::new()
        .route("/api/oauth2/token", post(fake_token))
        .route("/api/users/@me", get(fake_me))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), fake)
}

struct Harness {
    sup: Supervisor,
    api: Arc<ApiModule>,
    store: Store,
    auth: Arc<AuthService>,
    fake: Arc<FakeDiscord>,
    fake_url: String,
    http: reqwest::Client,
}

fn discord(id: &str) -> AccountRef {
    AccountRef {
        platform: PlatformId::new("discord"),
        id: id.to_owned(),
    }
}

async fn harness_with(oauth: bool) -> Harness {
    let (fake_url, fake) = start_fake().await;
    let services = Arc::new(ServiceRegistry::new());
    let sup = Supervisor::new(EventBus::default(), services.clone());
    let store = Store::memory();
    let k = ModuleId::from("kernel");
    services.provide::<SupervisorHandle>(&k, Arc::new(sup.clone()));
    services.provide(&k, Arc::new(ProfileId::from("test-chan")));
    services.provide::<dyn AuthStore>(&k, store.auth.clone());
    services.provide::<dyn AuditLog>(&k, store.audit.clone());
    services.provide::<dyn SettingsStore>(&k, store.settings.clone());
    services.provide(
        &ModuleId::from("queue"),
        Arc::new(RequestQueue::new(QueueConfig::default())),
    );
    let auth = AuthService::load(
        store.auth.clone(),
        Some(store.audit.clone()),
        vec![discord(OWNER)],
        "user",
    )
    .await
    .unwrap();
    let a = ModuleId::from("auth");
    services.provide(&a, auth.clone());
    services.provide::<dyn Authorizer>(&a, auth.clone());

    let mut config = json!({ "bind": "127.0.0.1:0", "token": TOKEN, "panel_dir": "" });
    if oauth {
        config["discord_oauth"] = json!({
            "client_id": "cid",
            "client_secret": "secret",
            "redirect_uri": REDIRECT,
            "recheck_secs": 0,
            "discord_url": fake_url,
        });
    }
    let api = Arc::new(ApiModule::new());
    sup.register(api.clone(), config, true).await;
    sup.start_all().await.unwrap();
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    Harness {
        sup,
        api,
        store,
        auth,
        fake,
        fake_url,
        http,
    }
}

struct Callback {
    location: String,
    cookie: Option<String>,
    set_cookie: Option<String>,
}

fn location(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(header::LOCATION)
        .expect("a Location header")
        .to_str()
        .unwrap()
        .to_owned()
}

impl Harness {
    fn base(&self) -> String {
        format!("http://{}", self.api.local_addr().expect("api is running"))
    }

    /// `GET /api/auth/oauth/login`; returns the Discord authorize URL.
    async fn start_login(&self, next: Option<&str>) -> Url {
        let mut url = Url::parse(&format!("{}/api/auth/oauth/login", self.base())).unwrap();
        if let Some(next) = next {
            url.query_pairs_mut().append_pair("next", next);
        }
        let response = self.http.get(url).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        Url::parse(&location(&response)).unwrap()
    }

    async fn callback(&self, query: &[(&str, &str)]) -> Callback {
        let mut url = Url::parse(&format!("{}/api/auth/oauth/callback", self.base())).unwrap();
        url.query_pairs_mut().extend_pairs(query);
        let response = self.http.get(url).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        let set_cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .map(|v| v.to_str().unwrap().to_owned());
        let cookie = set_cookie.as_deref().map(|c| {
            c.split(';')
                .next()
                .unwrap()
                .strip_prefix("miyoria_session=")
                .expect("the session cookie")
                .to_owned()
        });
        Callback {
            location: location(&response),
            cookie,
            set_cookie,
        }
    }

    /// Logs in as the user behind `code`, as a browser would.
    async fn login(&self, code: &str, next: Option<&str>) -> Callback {
        let authorize = self.start_login(next).await;
        let state = param(&authorize, "state");
        self.callback(&[("code", code), ("state", &state)]).await
    }

    async fn login_cookie(&self, code: &str) -> String {
        self.login(code, None).await.cookie.expect("logged in")
    }

    async fn with_cookie(
        &self,
        method: Method,
        path: &str,
        cookie: &str,
        csrf: bool,
    ) -> (StatusCode, Value) {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base()))
            .header(
                header::COOKIE,
                format!("theme=dark; miyoria_session={cookie}"),
            );
        if csrf {
            request = request.header("X-Miyoria-Request", "1");
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn audit_by(&self, actor: &str) -> Vec<AuditEntry> {
        self.store.audit.recent(100, Some(actor)).await.unwrap()
    }

    async fn persisted(&self) -> Vec<(String, Value)> {
        self.store
            .settings
            .list(&ProfileId::from("_global"), "panel_session:")
            .await
            .unwrap()
            .into_iter()
            .collect()
    }
}

fn param(url: &Url, name: &str) -> String {
    url.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| panic!("no `{name}` in {url}"))
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[tokio::test]
async fn full_login_flow_with_pkce() {
    let h = harness_with(true).await;
    let client = ApiClient::new(&h.base(), TOKEN).unwrap();
    let methods = client.auth_methods().await.unwrap();
    assert!(methods.token && methods.discord);

    let authorize = h.start_login(Some("/#/people")).await;
    assert_eq!(
        authorize.as_str().split('?').next().unwrap(),
        format!("{}/oauth2/authorize", h.fake_url)
    );
    assert_eq!(param(&authorize, "response_type"), "code");
    assert_eq!(param(&authorize, "client_id"), "cid");
    assert_eq!(param(&authorize, "scope"), "identify");
    assert_eq!(param(&authorize, "redirect_uri"), REDIRECT);
    assert_eq!(param(&authorize, "code_challenge_method"), "S256");
    let challenge = param(&authorize, "code_challenge");
    let state = param(&authorize, "state");
    assert!(state.len() >= 43, "state has 256 bits");

    let done = h
        .callback(&[("code", "owner-code"), ("state", &state)])
        .await;
    assert_eq!(done.location, "/#/people");
    let set_cookie = done.set_cookie.unwrap();
    for attr in ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"] {
        assert!(set_cookie.contains(attr), "{set_cookie} lacks {attr}");
    }
    assert!(!set_cookie.contains("Secure"), "plain-http redirect_uri");
    let cookie = done.cookie.unwrap();

    // The PKCE verifier went to the token endpoint and matches the challenge.
    let form = h.fake.token_requests.lock()[0].clone();
    let verifier = &form["code_verifier"];
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        challenge
    );
    assert_eq!(form["code"], "owner-code");

    // The cookie authenticates, as the Discord user.
    let (status, session) = h
        .with_cookie(Method::GET, "/api/auth/session", &cookie, false)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["method"], "discord");
    assert_eq!(session["user"]["id"], OWNER);
    assert_eq!(session["user"]["name"], "Owner Name");
    assert_eq!(
        session["user"]["avatar_url"],
        "https://cdn.discordapp.com/avatars/111/abc123.png?size=64"
    );
    assert_eq!(session["permissions"]["write"], true);
    let (status, _) = h
        .with_cookie(Method::GET, "/api/queue", &cookie, false)
        .await;
    assert_eq!(status, StatusCode::OK);

    // Changes need the CSRF header, and are audited as the account.
    let (status, body) = h
        .with_cookie(Method::POST, "/api/queue/pause", &cookie, false)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("x-miyoria-request")
    );
    let (status, body) = h
        .with_cookie(Method::POST, "/api/queue/pause", &cookie, true)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let audit = h.audit_by("discord:111").await;
    assert!(audit.iter().any(|e| e.action == "queue.pause"));
    assert!(audit.iter().any(|e| e.action == "panel.login" && e.ok));

    // The bearer token keeps working, as `"api"`.
    let me = client.session().await.unwrap();
    assert_eq!(me.method, "token");
    assert!(me.user.is_none() && me.permissions.write);
    client.queue_pause(false).await.unwrap();
    assert!(
        h.audit_by("api")
            .await
            .iter()
            .any(|e| e.action == "queue.resume")
    );
    // A wrong bearer token is not rescued by a valid cookie.
    let response = h
        .http
        .get(format!("{}/api/queue", h.base()))
        .bearer_auth("wrong")
        .header(header::COOKIE, format!("miyoria_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bad_state_cancel_exchange_failure_and_open_redirects() {
    let h = harness_with(true).await;

    let bogus = h
        .callback(&[("code", "owner-code"), ("state", "bogus")])
        .await;
    assert_eq!(bogus.location, "/#/login?error=state");
    assert!(bogus.set_cookie.is_none());
    let missing = h.callback(&[("code", "owner-code")]).await;
    assert_eq!(missing.location, "/#/login?error=state");

    // A state works once.
    let authorize = h.start_login(None).await;
    let state = param(&authorize, "state");
    let first = h
        .callback(&[("code", "owner-code"), ("state", &state)])
        .await;
    assert_eq!(first.location, "/#/", "default next");
    assert!(first.cookie.is_some());
    let replay = h
        .callback(&[("code", "owner-code"), ("state", &state)])
        .await;
    assert_eq!(replay.location, "/#/login?error=state");

    // The user pressed Cancel on Discord.
    let authorize = h.start_login(None).await;
    let state = param(&authorize, "state");
    let cancelled = h
        .callback(&[("error", "access_denied"), ("state", &state)])
        .await;
    assert_eq!(cancelled.location, "/#/login?error=cancelled");

    // Discord refused the code: no details leak.
    let bad = h.login("forged-code", None).await;
    assert_eq!(bad.location, "/#/login?error=exchange");
    assert!(bad.cookie.is_none());

    for evil in [
        "//evil.example/x",
        "https://evil.example",
        "/\\evil.example",
        "/ok\r\nSet-Cookie: x=1",
    ] {
        let done = h.login("owner-code", Some(evil)).await;
        assert_eq!(done.location, "/#/", "{evil:?}");
    }
}

#[tokio::test]
async fn denied_and_read_only_users() {
    let h = harness_with(true).await;

    let denied = h.login("stranger-code", None).await;
    assert_eq!(denied.location, "/#/login?error=denied");
    assert!(denied.set_cookie.is_none());
    assert!(h.persisted().await.is_empty());
    let audit = h.audit_by("discord:222").await;
    assert!(audit.iter().any(|e| e.action == "panel.login" && !e.ok));

    // A role with panel access but not write: reads only.
    h.auth
        .upsert_role(
            "test",
            RoleDefinition {
                name: "viewer".into(),
                rank: 50,
                grants: vec!["admin.panel.access".into()],
                denies: Vec::new(),
                builtin: false,
            },
        )
        .await
        .unwrap();
    h.auth
        .assign("test", &discord(VIEWER), "viewer", AuthScope::Global)
        .await
        .unwrap();
    let cookie = h.login_cookie("viewer-code").await;
    let (status, session) = h
        .with_cookie(Method::GET, "/api/auth/session", &cookie, false)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["user"]["name"], "viewer");
    assert!(
        session["user"]["avatar_url"]
            .as_str()
            .unwrap()
            .contains("/embed/avatars/")
    );
    assert_eq!(session["permissions"]["write"], false);
    let (status, _) = h
        .with_cookie(Method::GET, "/api/queue", &cookie, false)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = h
        .with_cookie(Method::POST, "/api/queue/pause", &cookie, true)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("admin.panel.write")
    );
}

#[tokio::test]
async fn logout_and_revocation() {
    let h = harness_with(true).await;

    h.auth
        .assign("test", &discord(ADMIN), "admin", AuthScope::Global)
        .await
        .unwrap();
    let cookie = h.login_cookie("admin-code").await;
    let (status, session) = h
        .with_cookie(Method::GET, "/api/auth/session", &cookie, false)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["permissions"]["write"], true, "admin has admin.*");
    h.auth
        .revoke("test", &discord(ADMIN), "admin", &AuthScope::Global)
        .await
        .unwrap();
    let (status, body) = h
        .with_cookie(Method::GET, "/api/queue", &cookie, false)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");

    let cookie = h.login_cookie("owner-code").await;
    assert_eq!(h.persisted().await.len(), 2);
    let response = h
        .http
        .post(format!("{}/api/auth/logout", h.base()))
        .header(header::COOKIE, format!("miyoria_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN, "CSRF guard");
    let response = h
        .http
        .post(format!("{}/api/auth/logout", h.base()))
        .header(header::COOKIE, format!("miyoria_session={cookie}"))
        .header("X-Miyoria-Request", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let cleared = response.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(cleared.starts_with("miyoria_session=;") && cleared.contains("Max-Age=0"));
    let (status, _) = h
        .with_cookie(Method::GET, "/api/auth/session", &cookie, false)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        h.persisted().await.len(),
        1,
        "only the revoked admin's left"
    );
}

#[tokio::test]
async fn sessions_persist_hashed_and_expire() {
    let h = harness_with(true).await;
    let cookie = h.login_cookie("owner-code").await;

    let persisted = h.persisted().await;
    assert_eq!(persisted.len(), 1);
    let (key, value) = &persisted[0];
    assert_eq!(key, &format!("panel_session:{}", sha256_hex(&cookie)));
    assert!(
        !value.to_string().contains(&cookie),
        "only the hash is stored"
    );
    assert_eq!(
        value["account"],
        json!({ "platform": "discord", "id": OWNER })
    );

    // A restart forgets the in-memory map; the store brings the session back.
    h.sup.restart(&ModuleId::from("api")).await.unwrap();
    let (status, session) = h
        .with_cookie(Method::GET, "/api/auth/session", &cookie, false)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["user"]["id"], OWNER);

    // An expired session is refused and deleted.
    let stale = "A".repeat(43);
    let mut record = value.clone();
    record["expires_at"] = json!((Utc::now() - chrono::Duration::minutes(1)).to_rfc3339());
    let stale_key = format!("panel_session:{}", sha256_hex(&stale));
    h.store
        .settings
        .set(&ProfileId::from("_global"), &stale_key, Some(record))
        .await
        .unwrap();
    let (status, _) = h
        .with_cookie(Method::GET, "/api/auth/session", &stale, false)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let keys: Vec<String> = h.persisted().await.into_iter().map(|(k, _)| k).collect();
    assert!(!keys.contains(&stale_key));
    assert_eq!(keys.len(), 1);
}

#[tokio::test]
async fn without_oauth_config_only_the_token_works() {
    let h = harness_with(false).await;
    let client = ApiClient::new(&h.base(), TOKEN).unwrap();
    let methods = client.auth_methods().await.unwrap();
    assert!(methods.token && !methods.discord);
    let response = h
        .http
        .get(format!("{}/api/auth/oauth/login", h.base()))
        .send()
        .await
        .unwrap();
    assert_eq!(location(&response), "/#/login?error=disabled");
    let (status, _) = h
        .with_cookie(Method::GET, "/api/queue", &"A".repeat(43), false)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(client.session().await.unwrap().method, "token");
}
