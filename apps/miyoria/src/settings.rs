//! Settings shared by `miyoria init` and `miyoria config`: field specs,
//! asking for one field (Enter keeps the current value), and the steps that
//! touch several keys at once (LLM, database, OAuth, tokens).

use std::fs;

use toml_edit::{Array, DocumentMut, Item, Value};

use crate::edit::{self, Workspace, format_key, single_ref};
use crate::prompt::Prompter;
use crate::ui;
use crate::validate::{self, Check};

pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:7878/api/auth/oauth/callback";
pub const DEFAULT_POSTGRES_URL: &str = "postgres://miyoria:miyoria@127.0.0.1:5432/miyoria";
pub const LLM_KINDS: &[&str] = &["deepseek", "openai", "openai-compatible", "opencode"];

pub fn default_base_url(kind: &str) -> Option<&'static str> {
    match kind {
        "deepseek" => Some("https://api.deepseek.com"),
        "openai" => Some("https://api.openai.com/v1"),
        "opencode" => Some("https://opencode.ai/inference/go/v1"),
        _ => None,
    }
}

fn default_model(kind: &str) -> &'static str {
    match kind {
        "deepseek" => "deepseek-chat",
        _ => "",
    }
}

fn api_key_var(kind: &str) -> &'static str {
    if kind == "opencode" {
        "OPENCODE_API_KEY"
    } else {
        "LLM_API_KEY"
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Text,
    Url,
    WsUrl,
    Bind,
    Port,
    Bool,
    /// Optional Discord id.
    Id,
    /// Comma separated Discord ids, stored as an array of strings.
    Ids,
    Secret,
    Choice(&'static [&'static str]),
}

impl Kind {
    fn check(self) -> Option<Check> {
        match self {
            Kind::Url => Some(validate::http_url),
            Kind::WsUrl => Some(validate::ws_url),
            Kind::Bind => Some(validate::bind),
            Kind::Port => Some(validate::port),
            Kind::Id => Some(validate::optional_discord_id),
            Kind::Ids => Some(validate::discord_ids),
            _ => None,
        }
    }
}

/// One editable setting: a `miyoria.toml` key, a `.env` variable, or a key
/// whose secret lives in `.env` (`env` names the variable to use when the
/// key has no `${VAR}` reference yet).
#[derive(Clone, Copy, Debug)]
pub struct Field<'a> {
    pub label: &'a str,
    pub key: Option<&'a str>,
    pub env: Option<&'a str>,
    pub kind: Kind,
    pub default: &'a str,
}

impl<'a> Field<'a> {
    pub const fn toml(label: &'a str, key: &'a str, kind: Kind) -> Self {
        Self {
            label,
            key: Some(key),
            env: None,
            kind,
            default: "",
        }
    }

    pub const fn env_only(label: &'a str, env: &'a str, kind: Kind) -> Self {
        Self {
            label,
            key: None,
            env: Some(env),
            kind,
            default: "",
        }
    }

    pub const fn env(self, env: &'a str) -> Self {
        Self {
            env: Some(env),
            ..self
        }
    }

    pub const fn default(self, default: &'a str) -> Self {
        Self { default, ..self }
    }
}

pub const PROFILE: Field = Field::toml(
    "角色(profiles/ 底下的資料夾名稱)",
    "core.profile",
    Kind::Text,
);
pub const DATABASE: Field =
    Field::toml("DATABASE_URL", "core.database_url", Kind::Text).env("DATABASE_URL");
pub const DISCORD_TOKEN: Field = Field::toml(
    "Discord bot token(可留空,之後再填)",
    r#"modules."platform.discord.bot".token"#,
    Kind::Secret,
)
.env("DISCORD_BOT_TOKEN");
pub const DISCORD_GUILDS: Field = Field::toml(
    "立即生效的伺服器 id(逗號分隔,空 = 全域)",
    r#"modules."platform.discord.bot".command_guilds"#,
    Kind::Ids,
);
pub const OWNER: Field = Field::env_only(
    "你的 Discord user id(擁有者權限,可留空)",
    "MIYORIA_OWNER_ID",
    Kind::Id,
);
pub const OAUTH_CLIENT_ID: Field = Field::toml(
    "Discord OAuth client id(Developer Portal → OAuth2)",
    "modules.api.discord_oauth.client_id",
    Kind::Id,
)
.env("DISCORD_CLIENT_ID");
pub const OAUTH_SECRET: Field = Field::toml(
    "Discord OAuth client secret",
    "modules.api.discord_oauth.client_secret",
    Kind::Secret,
)
.env("DISCORD_CLIENT_SECRET");
pub const OAUTH_REDIRECT: Field = Field::toml(
    "OAuth redirect URI",
    "modules.api.discord_oauth.redirect_uri",
    Kind::Url,
)
.default(DEFAULT_REDIRECT_URI);
pub const API_BIND: Field =
    Field::toml("Admin API / 面板位址", "modules.api.bind", Kind::Bind).default("127.0.0.1:7878");

pub const VOICE: &[Field] = &[
    Field::toml("ASR worker URL", "speech.asr.local.url", Kind::Url)
        .default("http://127.0.0.1:8001"),
    Field::toml("TTS worker URL", "speech.tts.local.url", Kind::Url)
        .default("http://127.0.0.1:8002"),
    Field::toml("TTS 聲音", "speech.tts.local.voice", Kind::Text),
    Field::toml(
        "語音節點連入位址(voice link)",
        r#"modules."voice.link".bind"#,
        Kind::Bind,
    )
    .default("127.0.0.1:7879"),
    Field::toml(
        "收音同意",
        "modules.voice.consent",
        Kind::Choice(&["opt-out", "opt-in"]),
    )
    .default("opt-out"),
    Field::toml(
        "有人插話時",
        "modules.voice.barge_in",
        Kind::Choice(&["stop", "ignore"]),
    )
    .default("stop"),
];

pub const STAGE: &[Field] = &[
    Field::toml("Stage 節點連到 core 的位址", "stage.core_url", Kind::WsUrl)
        .default("ws://127.0.0.1:7882/stage-link"),
    Field::toml(
        "core 等 Stage 節點連入的位址",
        r#"modules."stage.link".bind"#,
        Kind::Bind,
    )
    .default("127.0.0.1:7882"),
    Field::toml("VTube Studio", "stage.vts.enabled", Kind::Bool).default("true"),
    Field::toml("OBS", "stage.obs.enabled", Kind::Bool).default("false"),
    Field::toml("OBS 主機", "stage.obs.host", Kind::Text).default("127.0.0.1"),
    Field::toml("OBS WebSocket port", "stage.obs.port", Kind::Port).default("4455"),
    Field::toml("OBS WebSocket 密碼", "stage.obs.password", Kind::Secret).env("OBS_PASSWORD"),
];

/// Every static field, for `miyoria config set` on known secret keys.
pub fn all_fields() -> Vec<Field<'static>> {
    let mut out = vec![
        PROFILE,
        DATABASE,
        DISCORD_TOKEN,
        DISCORD_GUILDS,
        OWNER,
        OAUTH_CLIENT_ID,
        OAUTH_SECRET,
        OAUTH_REDIRECT,
        API_BIND,
    ];
    out.extend_from_slice(VOICE);
    out.extend_from_slice(STAGE);
    out
}

/// `(variable, keys referencing it, what uses it)`.
pub const TOKENS: &[(&str, &[&str], &str)] = &[
    (
        "MIYORIA_API_TOKEN",
        &["modules.api.token"],
        "Admin API(CLI、面板)",
    ),
    (
        "VOICE_LINK_TOKEN",
        &[r#"modules."voice.link".token"#],
        "語音節點(apps/voice-node 的 .env 要填同一個)",
    ),
    (
        "STAGE_LINK_TOKEN",
        &[r#"modules."stage.link".token"#, "stage.token"],
        "Stage 節點",
    ),
];

pub fn new_token() -> String {
    // Two ULIDs = 160 random bits; only authenticates local nodes / CLI.
    format!("{}{}", ulid::Ulid::new(), ulid::Ulid::new()).to_lowercase()
}

/// Current value of a field (references expanded; empty when unset).
pub struct Current {
    pub value: String,
    /// The key (or variable) exists at all.
    pub present: bool,
}

pub fn current(ws: &Workspace, field: &Field) -> Current {
    let Some(key) = field.key else {
        let var = field.env.unwrap_or_default();
        let found = ws.lookup(var);
        return Current {
            present: found.is_some(),
            value: found.map(|(v, _)| v).unwrap_or_default(),
        };
    };
    let Some(value) = ws.item(key).and_then(Item::as_value) else {
        return Current {
            value: String::new(),
            present: false,
        };
    };
    let value = match value.as_str() {
        Some(s) => ws.resolve(s).0,
        None => edit::plain(value),
    };
    Current {
        value,
        present: true,
    }
}

/// `label  [current]` for pick lists; secrets only say whether they are set.
pub fn field_label(ws: &Workspace, field: &Field) -> String {
    let cur = current(ws, field);
    let shown = if field.kind == Kind::Secret {
        if cur.value.is_empty() {
            "未設定"
        } else {
            "已設定"
        }
        .to_owned()
    } else if cur.value.is_empty() {
        if field.default.is_empty() {
            "未設定".to_owned()
        } else {
            format!("預設 {}", field.default)
        }
    } else {
        edit::mask_url(&cur.value)
    };
    format!("{}  [{shown}]", field.label)
}

pub fn secret_label(label: &str, is_set: bool) -> String {
    if is_set {
        format!("{label} [已設定(按 Enter 保留)]")
    } else {
        format!("{label} [未設定,可留空]")
    }
}

/// Asks for one field with the current value as default; writes only when
/// the answer differs. Returns whether anything changed.
pub fn ask(p: &mut dyn Prompter, ws: &mut Workspace, field: &Field) -> anyhow::Result<bool> {
    let cur = current(ws, field);
    let new = match field.kind {
        Kind::Secret => {
            let typed = p.secret(&secret_label(field.label, !cur.value.is_empty()))?;
            let typed = typed.trim();
            if typed.is_empty() {
                return Ok(false);
            }
            typed.to_owned()
        }
        Kind::Choice(options) => {
            let want = if cur.value.is_empty() {
                field.default
            } else {
                cur.value.as_str()
            };
            let start = options.iter().position(|o| *o == want).unwrap_or(0);
            let shown: Vec<String> = options.iter().map(|o| (*o).to_owned()).collect();
            options[p.select(field.label, &shown, start)?].to_owned()
        }
        Kind::Bool => {
            let default = if cur.present {
                cur.value == "true"
            } else {
                field.default == "true"
            };
            p.confirm(field.label, default)?.to_string()
        }
        kind => {
            let default = if cur.present && !cur.value.is_empty() {
                cur.value.clone()
            } else {
                field.default.to_owned()
            };
            p.text(field.label, &default, kind.check())?
                .trim()
                .to_owned()
        }
    };
    let unchanged = if cur.present {
        new == cur.value
    } else {
        new.is_empty() || new == field.default
    };
    if unchanged {
        return Ok(false);
    }
    apply(ws, field, &new)?;
    Ok(true)
}

/// Writes a field: into the `.env` variable a key references, as a new
/// `${VAR}` reference for secrets, or as a typed TOML value.
pub fn apply(ws: &mut Workspace, field: &Field, new: &str) -> anyhow::Result<()> {
    let Some(key) = field.key else {
        ws.set_env(field.env.unwrap_or_default(), new);
        return Ok(());
    };
    let referenced = ws
        .item(key)
        .and_then(Item::as_str)
        .and_then(single_ref)
        .map(|r| r.name.to_owned());
    if let Some(var) = referenced {
        ws.set_env(&var, new);
        return Ok(());
    }
    let absent = ws.item(key).is_none();
    if let Some(var) = field.env
        && (absent || field.kind == Kind::Secret)
    {
        ws.set(key, format!("${{{var}:-}}"))?;
        ws.set_env(var, new);
        return Ok(());
    }
    ws.set(key, typed(field.kind, new)?)
}

fn typed(kind: Kind, s: &str) -> anyhow::Result<Value> {
    Ok(match kind {
        Kind::Bool => Value::from(s == "true"),
        Kind::Port => Value::from(s.trim().parse::<i64>()?),
        Kind::Ids => Value::Array(
            s.split([',', ' '])
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .collect::<Array>(),
        ),
        _ => Value::from(s),
    })
}

/// Multi-select which fields to change, then ask each.
pub fn edit_fields(
    p: &mut dyn Prompter,
    ws: &mut Workspace,
    fields: &[Field],
) -> anyhow::Result<()> {
    let labels: Vec<String> = fields.iter().map(|f| field_label(ws, f)).collect();
    let picked = p.multi_select("要修改哪些?", &labels, &[])?;
    for i in picked {
        ask(p, ws, &fields[i])?;
    }
    Ok(())
}

// ---- profile -----------------------------------------------------------

fn list_profiles(ws: &Workspace) -> Vec<String> {
    let dir = ws.dir().join(
        ws.effective("core.profiles_dir")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "profiles".to_owned()),
    );
    let mut ids: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("profile.toml").exists())
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .collect();
    ids.sort();
    ids
}

pub fn profile_step(p: &mut dyn Prompter, ws: &mut Workspace) -> anyhow::Result<bool> {
    let mut ids = list_profiles(ws);
    if ids.is_empty() {
        return ask(p, ws, &PROFILE);
    }
    let cur = current(ws, &PROFILE).value;
    if !cur.is_empty() && !ids.contains(&cur) {
        ids.push(cur.clone());
    }
    let start = ids.iter().position(|i| *i == cur).unwrap_or(0);
    let picked = &ids[p.select("角色", &ids, start)?];
    if *picked == cur {
        return Ok(false);
    }
    apply(ws, &PROFILE, picked)?;
    Ok(true)
}

// ---- LLM ---------------------------------------------------------------

pub struct LlmState {
    pub provider: String,
    pub kind: String,
    pub model: String,
    /// `provider:model` the chat purpose uses now.
    pub reference: Option<String>,
}

fn providers(ws: &Workspace) -> Vec<(String, String)> {
    let Some(table) = ws.item("llm.providers").and_then(Item::as_table_like) else {
        return Vec::new();
    };
    table
        .iter()
        .map(|(name, item)| {
            let kind = item
                .get("kind")
                .and_then(Item::as_str)
                .unwrap_or("openai-compatible");
            (name.to_owned(), kind.to_owned())
        })
        .collect()
}

fn chat_ref(doc: &DocumentMut) -> Option<String> {
    let path = ["llm", "purposes", "chat"].map(str::to_owned);
    let item = edit::get(doc, &path)?;
    match item.as_value()? {
        Value::Array(a) => a.get(0)?.as_str().map(str::to_owned),
        Value::String(s) => Some(s.value().clone()),
        _ => None,
    }
}

pub fn llm_state(ws: &mut Workspace) -> LlmState {
    let from_profile = ws.profile_mut().and_then(|p| chat_ref(&p.doc));
    let reference = from_profile.or_else(|| chat_ref(&ws.doc));
    let providers = providers(ws);
    let (provider, model) = match reference.as_deref().and_then(|r| r.split_once(':')) {
        Some((p, m)) => (p.to_owned(), m.to_owned()),
        None => (
            providers
                .first()
                .map(|p| p.0.clone())
                .unwrap_or_else(|| "deepseek".to_owned()),
            String::new(),
        ),
    };
    let kind = providers
        .iter()
        .find(|(n, _)| *n == provider)
        .map(|(_, k)| k.clone())
        .unwrap_or_else(|| {
            if LLM_KINDS.contains(&provider.as_str()) {
                provider.clone()
            } else {
                "openai-compatible".to_owned()
            }
        });
    LlmState {
        provider,
        kind,
        model,
        reference,
    }
}

fn provider_key(provider: &str, field: &str) -> String {
    format!("llm.providers.{}.{field}", format_key(&[provider]))
}

/// Uses a provider of `kind`: an existing one, a new `[llm.providers.opencode]`,
/// or the current provider with its kind changed.
fn switch_kind(ws: &mut Workspace, provider: &str, kind: &str) -> anyhow::Result<String> {
    if let Some((name, _)) = providers(ws).into_iter().find(|(_, k)| k == kind) {
        return Ok(name);
    }
    let name = if kind == "opencode" {
        "opencode"
    } else {
        provider
    };
    ws.set(&provider_key(name, "kind"), kind)?;
    if kind == "opencode" {
        if ws.item(&provider_key(name, "base_url")).is_none() {
            ws.set(
                &provider_key(name, "base_url"),
                default_base_url(kind).unwrap_or_default(),
            )?;
        }
        if ws.item(&provider_key(name, "api_key")).is_none() {
            ws.set(&provider_key(name, "api_key"), "${OPENCODE_API_KEY:-}")?;
        }
    }
    Ok(name.to_owned())
}

/// Replaces `old` with `new` in every `[llm.purposes]` list of `doc`.
fn replace_ref(doc: &mut DocumentMut, old: &str, new: &str) -> bool {
    let Some(purposes) = doc
        .get_mut("llm")
        .and_then(|l| l.get_mut("purposes"))
        .and_then(Item::as_table_like_mut)
    else {
        return false;
    };
    let mut hit = false;
    for (_, item) in purposes.iter_mut() {
        let Some(list) = item.as_array_mut() else {
            continue;
        };
        for v in list.iter_mut() {
            if v.as_str() == Some(old) {
                let decor = v.decor().clone();
                *v = Value::from(new);
                *v.decor_mut() = decor;
                hit = true;
            }
        }
    }
    hit
}

fn set_model_ref(ws: &mut Workspace, old: Option<&str>, new: &str) -> anyhow::Result<()> {
    let mut hit = false;
    if let Some(old) = old {
        hit |= replace_ref(&mut ws.doc, old, new);
        if let Some(p) = ws.profile_mut() {
            hit |= replace_ref(&mut p.doc, old, new);
        }
    }
    if !hit {
        ws.set(
            "llm.purposes.chat",
            Value::Array([new].into_iter().collect()),
        )?;
    }
    Ok(())
}

pub fn llm_summary(ws: &mut Workspace) -> String {
    let st = llm_state(ws);
    if st.model.is_empty() {
        st.kind
    } else {
        format!("{} · {}", st.kind, st.model)
    }
}

/// Provider kind, base URL, API key and chat model. With `pick`, asks which
/// of them to change first.
pub fn llm_step(p: &mut dyn Prompter, ws: &mut Workspace, pick: bool) -> anyhow::Result<()> {
    let st = llm_state(ws);
    let base_field = |provider: &str, kind: &str| -> (String, &'static str) {
        (
            provider_key(provider, "base_url"),
            default_base_url(kind).unwrap_or(""),
        )
    };
    let mut todo = [true; 4];
    if pick {
        let (base_key, base_default) = base_field(&st.provider, &st.kind);
        let base_now = ws
            .effective(&base_key)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| base_default.to_owned());
        let key_missing = current(
            ws,
            &Field::toml("", &provider_key(&st.provider, "api_key"), Kind::Secret),
        )
        .value
        .is_empty();
        let labels = vec![
            format!("服務類型  [{}]", st.kind),
            format!("Base URL  [{base_now}]"),
            format!(
                "API key  [{}]",
                if key_missing {
                    "未設定"
                } else {
                    "已設定"
                }
            ),
            format!("模型  [{}]", st.model),
        ];
        let chosen = p.multi_select("要修改哪些?", &labels, &[])?;
        todo = [0, 1, 2, 3].map(|i| chosen.contains(&i));
    }

    let mut provider = st.provider.clone();
    let mut kind = st.kind.clone();
    if todo[0] {
        let options: Vec<String> = LLM_KINDS.iter().map(|k| (*k).to_owned()).collect();
        let start = LLM_KINDS.iter().position(|k| *k == kind).unwrap_or(0);
        let new_kind = LLM_KINDS[p.select("LLM API 類型", &options, start)?];
        if new_kind != kind {
            provider = switch_kind(ws, &provider, new_kind)?;
            kind = new_kind.to_owned();
            // The endpoint has to match the new kind; a new provider also
            // needs its key and a model.
            todo[1] = true;
            if provider != st.provider {
                todo[2] = true;
                todo[3] = true;
            }
        }
    }

    if todo[1] {
        let (key, default) = base_field(&provider, &kind);
        let field = Field::toml("LLM base URL", &key, Kind::Url).default(default);
        let suggest = kind != st.kind && provider == st.provider && !default.is_empty();
        if suggest {
            // Same provider, new kind: offer the new kind's endpoint.
            let typed = p.text(field.label, default, Some(validate::http_url))?;
            if typed.trim() != current(ws, &field).value {
                apply(ws, &field, typed.trim())?;
            }
        } else {
            ask(p, ws, &field)?;
        }
    }

    if todo[2] {
        let key = provider_key(&provider, "api_key");
        let field = Field::toml("LLM API key", &key, Kind::Secret).env(api_key_var(&kind));
        ask(p, ws, &field)?;
    }

    if todo[3] {
        let default = if provider == st.provider && !st.model.is_empty() {
            st.model.clone()
        } else {
            default_model(&kind).to_owned()
        };
        let model = p.text(
            "模型 id(會寫進角色的 profile.toml)",
            &default,
            Some(validate::model_id),
        )?;
        let new_ref = format!("{provider}:{}", model.trim());
        if st.reference.as_deref() != Some(new_ref.as_str()) {
            set_model_ref(ws, st.reference.as_deref(), &new_ref)?;
        }
    }
    Ok(())
}

// ---- database ------------------------------------------------------------

pub fn database_step(p: &mut dyn Prompter, ws: &mut Workspace) -> anyhow::Result<()> {
    let cur = current(ws, &DATABASE).value;
    let options = vec![
        "memory://(不保存,先試用)".to_owned(),
        "PostgreSQL(用 deploy/docker-compose.yml)".to_owned(),
    ];
    let is_pg = cur.starts_with("postgres");
    let new = if p.select("資料庫", &options, usize::from(is_pg))? == 0 {
        "memory://".to_owned()
    } else {
        let default = if is_pg {
            cur.as_str()
        } else {
            DEFAULT_POSTGRES_URL
        };
        p.text("DATABASE_URL", default, Some(validate::database_url))?
            .trim()
            .to_owned()
    };
    if new != cur {
        apply(ws, &DATABASE, &new)?;
    }
    Ok(())
}

// ---- panel login ---------------------------------------------------------

pub fn oauth_ready(ws: &Workspace) -> bool {
    [OAUTH_CLIENT_ID, OAUTH_SECRET, OAUTH_REDIRECT]
        .iter()
        .all(|f| !current(ws, f).value.is_empty())
}

/// Discord login for the admin panel (`[modules.api.discord_oauth]`).
pub fn oauth_step(p: &mut dyn Prompter, ws: &mut Workspace, init: bool) -> anyhow::Result<()> {
    let configured = ws.item("modules.api.discord_oauth").is_some();
    let fields = [OAUTH_CLIENT_ID, OAUTH_SECRET, OAUTH_REDIRECT, API_BIND];
    let todo: Vec<usize> = if init {
        if !p.confirm("設定管理面板的 Discord 登入(OAuth)?", configured)? {
            return Ok(());
        }
        vec![0, 1, 2]
    } else {
        let labels: Vec<String> = fields.iter().map(|f| field_label(ws, f)).collect();
        p.multi_select("要修改哪些?", &labels, &[])?
    };
    for i in &todo {
        ask(p, ws, &fields[*i])?;
    }
    let redirect_key = OAUTH_REDIRECT.key.unwrap_or_default();
    if ws.item("modules.api.discord_oauth").is_some() && ws.item(redirect_key).is_none() {
        apply(ws, &OAUTH_REDIRECT, DEFAULT_REDIRECT_URI)?;
    }
    if oauth_ready(ws) {
        ui::note(format!(
            "Discord Developer Portal → OAuth2 → Redirects 要加上 {}",
            current(ws, &OAUTH_REDIRECT).value
        ));
    } else if ws.item("modules.api.discord_oauth").is_some() {
        ui::warn("client id、client secret、redirect URI 都填了才會開啟 Discord 登入");
    }
    Ok(())
}

// ---- tokens --------------------------------------------------------------

/// Generates tokens that are missing (never replaces one that is set) and
/// adds missing `${VAR}` references. Returns the generated variables.
pub fn ensure_tokens(ws: &mut Workspace) -> anyhow::Result<Vec<&'static str>> {
    let mut generated = Vec::new();
    for (var, keys, _) in TOKENS {
        for key in *keys {
            if ws.item(key).is_none() {
                ws.set(key, format!("${{{var}:-}}"))?;
            }
        }
        if ws.lookup(var).is_none_or(|(v, _)| v.is_empty()) {
            ws.set_env(var, &new_token());
            generated.push(*var);
        }
    }
    Ok(generated)
}
