//! Format-preserving edits of `miyoria.toml` (via `toml_edit`), `.env`
//! (line based) and the active profile's `profile.toml`.
//!
//! Secrets live in `.env`; `miyoria.toml` points at them with `${VAR}` or
//! `${VAR:-default}`. Callers that edit a key holding such a reference write
//! the variable and leave the reference alone.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, anyhow, bail};
use toml_edit::{DocumentMut, InlineTable, Item, Table, Value};

static PROCESS_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// Remembers the real process environment before `.env` is loaded into it,
/// so values can be attributed to `.env` or to the environment.
pub fn capture_process_env() {
    let _ = PROCESS_ENV.set(std::env::vars().collect());
}

/// Directory holding `miyoria.toml` (and `.env`).
pub fn config_dir(config_path: &Path) -> &Path {
    config_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new(""))
}

// ---- dotted keys -----------------------------------------------------------

/// Splits `modules."voice.link".bind` into `["modules", "voice.link", "bind"]`.
pub fn parse_key(key: &str) -> anyhow::Result<Vec<String>> {
    let mut segments = Vec::new();
    let mut chars = key.trim().chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        let mut seg = String::new();
        match chars.peek() {
            Some('"') => {
                chars.next();
                loop {
                    match chars.next() {
                        Some('\\') => match chars.next() {
                            Some(c) => seg.push(c),
                            None => bail!("`{key}`:引號沒有結束"),
                        },
                        Some('"') => break,
                        Some(c) => seg.push(c),
                        None => bail!("`{key}`:引號沒有結束"),
                    }
                }
            }
            Some('\'') => {
                chars.next();
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => seg.push(c),
                        None => bail!("`{key}`:引號沒有結束"),
                    }
                }
            }
            _ => {
                while let Some(&c) = chars.peek() {
                    if c == '.' || c.is_whitespace() {
                        break;
                    }
                    if !is_bare_char(c) {
                        bail!(
                            "`{key}`:鍵名裡有 `{c}` 的部分要加引號,例如 modules.\"voice.link\".bind"
                        );
                    }
                    seg.push(c);
                    chars.next();
                }
                if seg.is_empty() {
                    bail!("`{key}`:有空的鍵名");
                }
            }
        }
        segments.push(seg);
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        match chars.next() {
            None => break,
            Some('.') => {}
            Some(c) => bail!("`{key}`:多了 `{c}`"),
        }
    }
    Ok(segments)
}

fn is_bare_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Inverse of [`parse_key`]; quotes segments that are not bare keys.
pub fn format_key<S: AsRef<str>>(path: &[S]) -> String {
    path.iter()
        .map(|s| {
            let s = s.as_ref();
            if !s.is_empty() && s.chars().all(is_bare_char) {
                s.to_owned()
            } else {
                format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

// ---- TOML tree -------------------------------------------------------------

pub fn get<'a>(doc: &'a DocumentMut, path: &[String]) -> Option<&'a Item> {
    path.iter()
        .try_fold(doc.as_item(), |item, seg| item.get(seg.as_str()))
}

/// Sets a value, creating missing tables. An existing value keeps its
/// surrounding whitespace and trailing comment; new keys go at the end of
/// their table, new tables right after their parent table.
pub fn set(doc: &mut DocumentMut, path: &[String], mut value: Value) -> anyhow::Result<()> {
    let (last, parents) = path.split_last().ok_or_else(|| anyhow!("鍵名是空的"))?;
    let mut item = doc.as_item_mut();
    for (i, seg) in parents.iter().enumerate() {
        item = child_table(item, seg, i + 1 < parents.len(), &path[..=i])?;
    }
    let table = item
        .as_table_like_mut()
        .ok_or_else(|| anyhow!("`{}` 不是表格", format_key(parents)))?;
    match table.get_mut(last) {
        Some(Item::Value(old)) => {
            *value.decor_mut() = old.decor().clone();
            *old = value;
        }
        Some(Item::None) | None => {
            table.insert(last, Item::Value(value));
        }
        Some(_) => bail!("`{}` 是表格,不能設成單一值", format_key(path)),
    }
    Ok(())
}

fn child_table<'a>(
    item: &'a mut Item,
    seg: &str,
    implicit: bool,
    shown: &[String],
) -> anyhow::Result<&'a mut Item> {
    let inline = matches!(item, Item::Value(_));
    let table = item
        .as_table_like_mut()
        .ok_or_else(|| anyhow!("`{}` 不是表格", format_key(&shown[..shown.len() - 1])))?;
    if table.get(seg).is_none_or(Item::is_none) {
        let new = if inline {
            Item::Value(Value::InlineTable(InlineTable::new()))
        } else {
            let mut t = Table::new();
            t.set_implicit(implicit);
            Item::Table(t)
        };
        table.insert(seg, new);
    }
    let child = table.get_mut(seg).expect("inserted above");
    if !child.is_table_like() {
        bail!("`{}` 是單一值,不是表格", format_key(shown));
    }
    Ok(child)
}

/// Removes a key or table; `None` when it was not there.
pub fn unset(doc: &mut DocumentMut, path: &[String]) -> Option<Item> {
    let (last, parents) = path.split_last()?;
    let mut item = doc.as_item_mut();
    for seg in parents {
        item = item.get_mut(seg.as_str())?;
    }
    item.as_table_like_mut()?.remove(last)
}

/// Parses a command-line value as TOML (`3`, `true`, `["a"]`, `"x"`);
/// anything that is not valid TOML is taken as a plain string.
pub fn parse_value(text: &str) -> Value {
    match text.trim().parse::<Value>() {
        Ok(mut v) => {
            v.decor_mut().clear();
            v
        }
        Err(_) => Value::from(text),
    }
}

/// TOML text of a value without surrounding whitespace or comments.
pub fn show(value: &Value) -> String {
    let mut v = value.clone();
    v.decor_mut().clear();
    match &mut v {
        Value::Array(a) => a.fmt(),
        Value::InlineTable(t) => t.fmt(),
        _ => {}
    }
    v.to_string()
}

/// Strings without quotes, everything else as TOML.
pub fn plain(value: &Value) -> String {
    match value {
        Value::String(s) => s.value().clone(),
        Value::Array(a) => a.iter().map(plain).collect::<Vec<_>>().join(", "),
        other => show(other),
    }
}

#[derive(Clone, Debug)]
pub struct Leaf {
    pub path: Vec<String>,
    pub value: Value,
}

/// Every value in document order (inline tables and arrays of tables are
/// walked into).
pub fn leaves(item: &Item) -> Vec<Leaf> {
    fn walk(item: &Item, path: &mut Vec<String>, out: &mut Vec<Leaf>) {
        match item {
            Item::ArrayOfTables(a) => {
                for (i, t) in a.iter().enumerate() {
                    path.push(i.to_string());
                    for (k, v) in t.iter() {
                        path.push(k.to_owned());
                        walk(v, path, out);
                        path.pop();
                    }
                    path.pop();
                }
            }
            Item::Value(v) if !v.is_inline_table() => out.push(Leaf {
                path: path.clone(),
                value: v.clone(),
            }),
            Item::None => {}
            other => {
                if let Some(t) = other.as_table_like() {
                    for (k, v) in t.iter() {
                        path.push(k.to_owned());
                        walk(v, path, out);
                        path.pop();
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(item, &mut Vec::new(), &mut out);
    out
}

// ---- ${VAR} references -----------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnvRef<'a> {
    pub name: &'a str,
    pub default: Option<&'a str>,
}

fn split_ref(expr: &str) -> EnvRef<'_> {
    match expr.split_once(":-") {
        Some((name, default)) => EnvRef {
            name,
            default: Some(default),
        },
        None => EnvRef {
            name: expr,
            default: None,
        },
    }
}

/// All `${...}` references in a string.
pub fn env_refs(s: &str) -> Vec<EnvRef<'_>> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else { break };
        out.push(split_ref(&after[..end]));
        rest = &after[end + 1..];
    }
    out
}

/// The reference when the whole string is exactly one `${VAR}` /
/// `${VAR:-default}`.
pub fn single_ref(s: &str) -> Option<EnvRef<'_>> {
    let inner = s.strip_prefix("${")?.strip_suffix('}')?;
    if inner.contains('}') || inner.contains("${") {
        return None;
    }
    let r = split_ref(inner);
    is_env_name(r.name).then_some(r)
}

pub fn is_env_name(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with(|c: char| c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Where an effective value came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    DotEnv,
    Process,
    Default,
    Unset,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::DotEnv => ".env",
            Source::Process => "環境變數",
            Source::Default => "預設值",
            Source::Unset => "未設定",
        }
    }
}

/// Expands references like the kernel does, reporting each variable's source.
pub fn expand(
    s: &str,
    lookup: &dyn Fn(&str) -> Option<(String, Source)>,
) -> (String, Vec<(String, Source)>) {
    let mut out = String::with_capacity(s.len());
    let mut used = Vec::new();
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return (out, used);
        };
        let r = split_ref(&after[..end]);
        let name = r.name.to_owned();
        match (lookup(r.name), r.default) {
            (Some((v, src)), _) if !v.is_empty() => {
                out.push_str(&v);
                used.push((name, src));
            }
            (_, Some(d)) => {
                out.push_str(d);
                used.push((name, Source::Default));
            }
            (Some((v, src)), None) => {
                out.push_str(&v);
                used.push((name, src));
            }
            (None, None) => used.push((name, Source::Unset)),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    (out, used)
}

// ---- secrets ---------------------------------------------------------------

/// Key or variable names whose values must not be printed.
pub fn is_secret(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["token", "secret", "password", "passwd", "api_key", "apikey"]
        .iter()
        .any(|w| n.contains(w))
}

/// `••••` plus the last four characters of long values.
pub fn mask(value: &str) -> String {
    let n = value.chars().count();
    match n {
        0 => "(空)".to_owned(),
        1..=8 => "••••".to_owned(),
        _ => {
            let tail: String = value.chars().skip(n - 4).collect();
            format!("••••{tail}")
        }
    }
}

/// Hides the password of `scheme://user:password@host` URLs.
pub fn mask_url(value: &str) -> String {
    match reqwest::Url::parse(value) {
        Ok(mut url) if url.password().is_some() => {
            let _ = url.set_password(Some("****"));
            url.to_string()
        }
        _ => value.to_owned(),
    }
}

/// How to print `value` of key / variable `name`.
pub fn display(name: &str, value: &str, reveal: bool) -> String {
    if reveal {
        value.to_owned()
    } else if is_secret(name) {
        mask(value)
    } else {
        mask_url(value)
    }
}

// ---- .env ------------------------------------------------------------------

/// A `.env` file edited line by line: comments, blank lines and order stay.
#[derive(Clone, Debug, Default)]
pub struct EnvFile {
    lines: Vec<String>,
    crlf: bool,
}

impl EnvFile {
    pub fn parse(text: &str) -> Self {
        Self {
            lines: text.lines().map(str::to_owned).collect(),
            crlf: text.contains("\r\n"),
        }
    }

    pub fn render(&self) -> String {
        if self.lines.is_empty() {
            return String::new();
        }
        let nl = if self.crlf { "\r\n" } else { "\n" };
        let mut out = self.lines.join(nl);
        out.push_str(nl);
        out
    }

    fn split(line: &str) -> Option<(&str, &str)> {
        let t = line.trim_start();
        if t.starts_with('#') {
            return None;
        }
        let t = t.strip_prefix("export ").map(str::trim_start).unwrap_or(t);
        let (k, v) = t.split_once('=')?;
        let k = k.trim();
        is_env_name(k).then_some((k, v))
    }

    fn position(&self, key: &str) -> Option<usize> {
        self.lines
            .iter()
            .position(|l| Self::split(l).is_some_and(|(k, _)| k == key))
    }

    /// Unquoted value; the first definition wins, as with dotenvy.
    pub fn get(&self, key: &str) -> Option<String> {
        self.lines.iter().find_map(|l| match Self::split(l) {
            Some((k, v)) if k == key => Some(unquote(v)),
            _ => None,
        })
    }

    pub fn entries(&self) -> Vec<(String, String)> {
        let mut seen = HashSet::new();
        self.lines
            .iter()
            .filter_map(|l| Self::split(l))
            .filter(|(k, _)| seen.insert(k.to_string()))
            .map(|(k, v)| (k.to_owned(), unquote(v)))
            .collect()
    }

    pub fn set(&mut self, key: &str, value: &str) {
        let line = format!("{key}={}", quote(value));
        match self.position(key) {
            Some(i) => {
                let export = self.lines[i].trim_start().starts_with("export ");
                self.lines[i] = if export {
                    format!("export {line}")
                } else {
                    line
                };
            }
            None => self.lines.push(line),
        }
    }

    pub fn unset(&mut self, key: &str) -> bool {
        let before = self.lines.len();
        self.lines
            .retain(|l| Self::split(l).is_none_or(|(k, _)| k != key));
        self.lines.len() != before
    }
}

fn unquote(raw: &str) -> String {
    let v = raw.trim();
    if let Some(rest) = v.strip_prefix('\'') {
        return rest.split_once('\'').map_or(rest, |(a, _)| a).to_owned();
    }
    if let Some(rest) = v.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => break,
                '\\' => match chars.next() {
                    Some('n') => out.push('\n'),
                    Some(c) => out.push(c),
                    None => break,
                },
                c => out.push(c),
            }
        }
        return out;
    }
    match v.find(" #") {
        Some(i) => v[..i].trim_end().to_owned(),
        None => v.to_owned(),
    }
}

/// Bare when safe; single quotes otherwise (no `$` expansion in dotenvy).
fn quote(value: &str) -> String {
    let bare = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_-./:@+,=%~?&".contains(c));
    if bare {
        value.to_owned()
    } else if !value.contains('\'') && !value.contains('\n') {
        format!("'{value}'")
    } else {
        let mut out = String::from("\"");
        for c in value.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '$' => out.push_str("\\$"),
                '\n' => out.push_str("\\n"),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }
}

// ---- changes ---------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Toml,
    Env,
    Profile,
}

/// One changed key; `old` / `new` are display strings with secrets masked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub target: Target,
    pub key: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

impl Change {
    pub fn render(&self) -> String {
        match (&self.old, &self.new) {
            (None, Some(n)) => format!("+ {} = {n}", self.key),
            (Some(o), Some(n)) => format!("~ {}: {o} → {n}", self.key),
            (Some(o), None) => format!("- {}(原本 {o})", self.key),
            (None, None) => format!("  {}", self.key),
        }
    }
}

fn leaf_display(path: &[String], value: &Value) -> String {
    match value.as_str() {
        Some(s) if !s.contains("${") && path.last().is_some_and(|k| is_secret(k)) => {
            format!("\"{}\"", mask(s))
        }
        Some(s) if s.contains('@') => format!("\"{}\"", mask_url(s)),
        _ => show(value),
    }
}

fn leaf_map(doc: &DocumentMut) -> Vec<(String, String)> {
    leaves(doc.as_item())
        .iter()
        .map(|l| (format_key(&l.path), leaf_display(&l.path, &l.value)))
        .collect()
}

pub fn diff_toml(base: &str, doc: &DocumentMut, target: Target) -> Vec<Change> {
    let before = base
        .parse::<DocumentMut>()
        .map(|d| leaf_map(&d))
        .unwrap_or_default();
    let after = leaf_map(doc);
    diff_pairs(&before, &after, target)
}

pub fn diff_env(base: &EnvFile, now: &EnvFile) -> Vec<Change> {
    let shown = |e: &EnvFile| -> Vec<(String, String)> {
        e.entries()
            .into_iter()
            .map(|(k, v)| {
                let d = display(&k, &v, false);
                (k, d)
            })
            .collect()
    };
    diff_pairs(&shown(base), &shown(now), Target::Env)
}

fn diff_pairs(
    before: &[(String, String)],
    after: &[(String, String)],
    target: Target,
) -> Vec<Change> {
    let old: HashMap<&str, &str> = before
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let new_keys: HashSet<&str> = after.iter().map(|(k, _)| k.as_str()).collect();
    let mut out = Vec::new();
    for (k, v) in after {
        match old.get(k.as_str()) {
            Some(o) if o == v => {}
            o => out.push(Change {
                target,
                key: k.clone(),
                old: o.map(|s| s.to_string()),
                new: Some(v.clone()),
            }),
        }
    }
    for (k, v) in before {
        if !new_keys.contains(k.as_str()) {
            out.push(Change {
                target,
                key: k.clone(),
                old: Some(v.clone()),
                new: None,
            });
        }
    }
    out
}

// ---- workspace -------------------------------------------------------------

pub struct ProfileDoc {
    pub path: PathBuf,
    pub doc: DocumentMut,
    base: String,
}

/// `miyoria.toml` + `.env` (+ the active profile) loaded for editing.
/// Nothing touches the disk until [`Workspace::save`].
pub struct Workspace {
    pub config_path: PathBuf,
    pub env_path: PathBuf,
    pub doc: DocumentMut,
    pub env: EnvFile,
    toml_base: String,
    env_base: EnvFile,
    toml_exists: bool,
    env_exists: bool,
    profile: Option<ProfileDoc>,
    process_env: HashMap<String, String>,
    /// Notes collected while editing (shown before confirming).
    pub warnings: Vec<String>,
}

fn read_or(path: &Path, template: &str) -> anyhow::Result<(String, bool)> {
    match fs::read_to_string(path) {
        Ok(text) => Ok((text, true)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((template.to_owned(), false)),
        Err(e) => Err(e).with_context(|| format!("讀取 {} 失敗", path.display())),
    }
}

impl Workspace {
    /// Opens existing files; a missing `miyoria.toml` is an error.
    pub fn open(config_path: &Path) -> anyhow::Result<Self> {
        if !config_path.exists() {
            bail!(
                "找不到 {}:先執行 `miyoria init` 建立設定",
                config_path.display()
            );
        }
        Self::open_or_create(config_path, "", "")
    }

    /// Opens the files, starting missing ones from the templates.
    pub fn open_or_create(
        config_path: &Path,
        toml_template: &str,
        env_template: &str,
    ) -> anyhow::Result<Self> {
        let env_path = config_dir(config_path).join(".env");
        let (toml_text, toml_exists) = read_or(config_path, toml_template)?;
        let (env_text, env_exists) = read_or(&env_path, env_template)?;
        let doc = toml_text
            .parse::<DocumentMut>()
            .with_context(|| format!("{} 不是合法的 TOML", config_path.display()))?;
        let env = EnvFile::parse(&env_text);
        Ok(Self {
            config_path: config_path.to_owned(),
            env_path,
            doc,
            env_base: env.clone(),
            env,
            toml_base: toml_text,
            toml_exists,
            env_exists,
            profile: None,
            process_env: PROCESS_ENV.get().cloned().unwrap_or_default(),
            warnings: Vec::new(),
        })
    }

    #[cfg(test)]
    pub fn with_process_env(mut self, env: HashMap<String, String>) -> Self {
        self.process_env = env;
        self
    }

    pub fn dir(&self) -> &Path {
        config_dir(&self.config_path)
    }

    pub fn toml_exists(&self) -> bool {
        self.toml_exists
    }

    /// Value of a variable: the real environment wins over `.env`, as at runtime.
    pub fn lookup(&self, name: &str) -> Option<(String, Source)> {
        if let Some(v) = self.process_env.get(name).filter(|v| !v.is_empty()) {
            return Some((v.clone(), Source::Process));
        }
        self.env.get(name).map(|v| (v, Source::DotEnv))
    }

    pub fn resolve(&self, s: &str) -> (String, Vec<(String, Source)>) {
        expand(s, &|name| self.lookup(name))
    }

    pub fn item(&self, key: &str) -> Option<&Item> {
        get(&self.doc, &parse_key(key).ok()?)
    }

    /// Effective value of a key with references expanded.
    pub fn effective(&self, key: &str) -> Option<String> {
        let value = self.item(key)?.as_value()?;
        Some(match value.as_str() {
            Some(s) => self.resolve(s).0,
            None => plain(value),
        })
    }

    pub fn set(&mut self, key: &str, value: impl Into<Value>) -> anyhow::Result<()> {
        set(&mut self.doc, &parse_key(key)?, value.into())
    }

    pub fn unset(&mut self, key: &str) -> anyhow::Result<bool> {
        Ok(unset(&mut self.doc, &parse_key(key)?).is_some())
    }

    pub fn set_env(&mut self, name: &str, value: &str) {
        if self.process_env.get(name).is_some_and(|v| !v.is_empty()) {
            self.warnings.push(format!(
                "{name} 也設在系統環境變數裡,執行時會蓋過 .env 的值"
            ));
        }
        self.env.set(name, value);
    }

    /// `miyoria.toml` keys whose strings reference `${var}`.
    pub fn references(&self, var: &str) -> Vec<String> {
        fn mentions(value: &Value, var: &str) -> bool {
            match value {
                Value::String(s) => env_refs(s.value()).iter().any(|r| r.name == var),
                Value::Array(a) => a.iter().any(|v| mentions(v, var)),
                Value::InlineTable(t) => t.iter().any(|(_, v)| mentions(v, var)),
                _ => false,
            }
        }
        leaves(self.doc.as_item())
            .into_iter()
            .filter(|l| mentions(&l.value, var))
            .map(|l| format_key(&l.path))
            .collect()
    }

    pub fn profile_path(&self) -> Option<PathBuf> {
        let id = self.effective("core.profile").filter(|s| !s.is_empty())?;
        let dir = self
            .effective("core.profiles_dir")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "profiles".to_owned());
        Some(self.dir().join(dir).join(id).join("profile.toml"))
    }

    /// The active profile's `profile.toml`, loaded on first use (and again
    /// when `core.profile` changed).
    pub fn profile_mut(&mut self) -> Option<&mut ProfileDoc> {
        let path = self.profile_path()?;
        if self.profile.as_ref().is_none_or(|p| p.path != path) {
            let text = fs::read_to_string(&path).ok()?;
            let doc = text.parse::<DocumentMut>().ok()?;
            self.profile = Some(ProfileDoc {
                path,
                doc,
                base: text,
            });
        }
        self.profile.as_mut()
    }

    /// Files that do not exist yet and will be created by [`Self::save`].
    pub fn missing_files(&self) -> Vec<&Path> {
        let mut out = Vec::new();
        if !self.toml_exists {
            out.push(self.config_path.as_path());
        }
        if !self.env_exists {
            out.push(self.env_path.as_path());
        }
        out
    }

    pub fn changes(&self) -> Vec<Change> {
        let mut out = diff_toml(&self.toml_base, &self.doc, Target::Toml);
        out.extend(diff_env(&self.env_base, &self.env));
        if let Some(p) = &self.profile {
            out.extend(diff_toml(&p.base, &p.doc, Target::Profile));
        }
        out
    }

    pub fn path_of(&self, target: Target) -> Option<&Path> {
        match target {
            Target::Toml => Some(&self.config_path),
            Target::Env => Some(&self.env_path),
            Target::Profile => self.profile.as_ref().map(|p| p.path.as_path()),
        }
    }

    /// Writes changed (or missing) files; returns the paths written.
    pub fn save(&mut self) -> anyhow::Result<Vec<PathBuf>> {
        let mut written = Vec::new();
        let toml = self.doc.to_string();
        if !self.toml_exists || toml != self.toml_base {
            fs::write(&self.config_path, &toml)
                .with_context(|| format!("寫入 {} 失敗", self.config_path.display()))?;
            written.push(self.config_path.clone());
            self.toml_base = toml;
            self.toml_exists = true;
        }
        let env = self.env.render();
        if !self.env_exists || env != self.env_base.render() {
            fs::write(&self.env_path, &env)
                .with_context(|| format!("寫入 {} 失敗", self.env_path.display()))?;
            written.push(self.env_path.clone());
            self.env_base = self.env.clone();
            self.env_exists = true;
        }
        if let Some(p) = &mut self.profile {
            let text = p.doc.to_string();
            if text != p.base {
                fs::write(&p.path, &text)
                    .with_context(|| format!("寫入 {} 失敗", p.path.display()))?;
                written.push(p.path.clone());
                p.base = text;
            }
        }
        Ok(written)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fresh, empty directory under the system temp dir.
    pub fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("miyoria-test-{}", ulid::Ulid::new()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const SAMPLE: &str = r#"# top comment
[core]
profile = "deepseek-chan"          # profiles/<id>/
database_url = "${DATABASE_URL:-memory://}"

# ---- LLM ----
[llm.providers.deepseek]
kind = "deepseek"                  # deepseek | openai
api_key = "${LLM_API_KEY:-}"

[llm.purposes]
chat = ["deepseek:deepseek-chat"]

# Admin API
[modules.api]
bind = "127.0.0.1:7878"
token = "${MIYORIA_API_TOKEN:-}"

# voice link
[modules."voice.link"]
bind = "127.0.0.1:7879"
"#;

    fn doc() -> DocumentMut {
        SAMPLE.parse().unwrap()
    }

    fn key(k: &str) -> Vec<String> {
        parse_key(k).unwrap()
    }

    #[test]
    fn parses_dotted_keys() {
        assert_eq!(key("core.profile"), ["core", "profile"]);
        assert_eq!(
            key(r#"modules."voice.link".bind"#),
            ["modules", "voice.link", "bind"]
        );
        assert_eq!(key("a.'b.c' . d"), ["a", "b.c", "d"]);
        assert!(parse_key("a..b").is_err());
        assert!(parse_key("modules.voice/link").is_err());
        assert!(parse_key("a.\"open").is_err());
        assert_eq!(
            format_key(&key(r#"modules."platform.discord.bot".token"#)),
            r#"modules."platform.discord.bot".token"#
        );
    }

    #[test]
    fn replacing_a_value_keeps_comments_and_layout() {
        let mut d = doc();
        set(
            &mut d,
            &key("llm.providers.deepseek.kind"),
            "opencode".into(),
        )
        .unwrap();
        let expected = SAMPLE.replace(
            "kind = \"deepseek\"                  # deepseek | openai",
            "kind = \"opencode\"                  # deepseek | openai",
        );
        assert_eq!(d.to_string(), expected);
    }

    #[test]
    fn new_keys_land_in_their_table() {
        let mut d = doc();
        set(&mut d, &key("modules.api.enabled"), false.into()).unwrap();
        let text = d.to_string();
        assert!(
            text.contains("token = \"${MIYORIA_API_TOKEN:-}\"\nenabled = false\n\n# voice link"),
            "{text}"
        );
        // References elsewhere are untouched.
        assert!(text.contains("database_url = \"${DATABASE_URL:-memory://}\""));
        assert!(text.contains("api_key = \"${LLM_API_KEY:-}\""));
    }

    #[test]
    fn new_subtables_follow_their_parent() {
        let mut d = doc();
        set(
            &mut d,
            &key("modules.api.discord_oauth.client_id"),
            "${DISCORD_CLIENT_ID:-}".into(),
        )
        .unwrap();
        set(
            &mut d,
            &key("llm.providers.opencode.kind"),
            "opencode".into(),
        )
        .unwrap();
        let text = d.to_string();
        let oauth = text.find("[modules.api.discord_oauth]").expect(&text);
        assert!(oauth > text.find("[modules.api]").unwrap());
        assert!(oauth < text.find("# voice link").unwrap(), "{text}");
        let opencode = text.find("[llm.providers.opencode]").expect(&text);
        assert!(opencode > text.find("[llm.providers.deepseek]").unwrap());
        assert!(opencode < text.find("[llm.purposes]").unwrap(), "{text}");
        // Brand-new top-level tables go to the end.
        set(&mut d, &key("memory.embedding.model"), "bge-m3".into()).unwrap();
        assert!(
            d.to_string()
                .ends_with("[memory.embedding]\nmodel = \"bge-m3\"\n")
        );
        assert!(!d.to_string().contains("[memory]\n"));
    }

    #[test]
    fn quoted_table_names_and_unset() {
        let mut d = doc();
        set(
            &mut d,
            &key(r#"modules."voice.link".bind"#),
            "0.0.0.0:7879".into(),
        )
        .unwrap();
        assert!(
            d.to_string()
                .contains("[modules.\"voice.link\"]\nbind = \"0.0.0.0:7879\"")
        );
        assert!(unset(&mut d, &key("core.database_url")).is_some());
        assert!(unset(&mut d, &key("core.nope")).is_none());
        assert!(unset(&mut d, &key("nope.nope")).is_none());
        assert!(!d.to_string().contains("database_url"));
        assert!(set(&mut d, &key("core.profile.x"), 1.into()).is_err());
        assert!(set(&mut d, &key("llm.providers"), 1.into()).is_err());
    }

    #[test]
    fn parses_cli_values() {
        assert_eq!(parse_value("3").as_integer(), Some(3));
        assert_eq!(parse_value("true").as_bool(), Some(true));
        assert_eq!(parse_value("debug").as_str(), Some("debug"));
        assert_eq!(parse_value("\"7\"").as_str(), Some("7"));
        assert_eq!(parse_value("http://x:1/a").as_str(), Some("http://x:1/a"));
        assert_eq!(show(&parse_value("[\"a\",  \"b\"]")), "[\"a\", \"b\"]");
    }

    #[test]
    fn env_file_edits_preserve_lines() {
        let text = "# comment\nA=1\n\nexport B=\"two words\" \nC='x$y' # c\nD=plain # note\n";
        let mut env = EnvFile::parse(text);
        assert_eq!(env.get("A").as_deref(), Some("1"));
        assert_eq!(env.get("B").as_deref(), Some("two words"));
        assert_eq!(env.get("C").as_deref(), Some("x$y"));
        assert_eq!(env.get("D").as_deref(), Some("plain"));
        assert_eq!(env.get("E"), None);
        env.set("A", "2");
        env.set("B", "has $dollar");
        env.set("E", "a\"b'c");
        assert_eq!(
            env.render(),
            "# comment\nA=2\n\nexport B='has $dollar'\nC='x$y' # c\nD=plain # note\nE=\"a\\\"b'c\"\n"
        );
        assert_eq!(
            EnvFile::parse(&env.render()).get("E").as_deref(),
            Some("a\"b'c")
        );
        assert!(env.unset("C"));
        assert!(!env.unset("C"));
        assert!(!env.render().contains("C="));
        let crlf = EnvFile::parse("A=1\r\nB=2\r\n");
        assert_eq!(crlf.render(), "A=1\r\nB=2\r\n");
    }

    #[test]
    fn references_and_expansion() {
        assert_eq!(
            single_ref("${A:-x}"),
            Some(EnvRef {
                name: "A",
                default: Some("x")
            })
        );
        assert_eq!(single_ref("discord:${A}"), None);
        assert_eq!(env_refs("discord:${OWNER:-0}")[0].name, "OWNER");
        let lookup = |n: &str| match n {
            "SET" => Some(("v".to_owned(), Source::DotEnv)),
            "EMPTY" => Some((String::new(), Source::DotEnv)),
            _ => None,
        };
        let (v, used) = expand("a-${SET}-${EMPTY:-d}-${NONE:-}", &lookup);
        assert_eq!(v, "a-v-d-");
        assert_eq!(
            used,
            [
                ("SET".to_owned(), Source::DotEnv),
                ("EMPTY".to_owned(), Source::Default),
                ("NONE".to_owned(), Source::Default)
            ]
        );
        assert_eq!(expand("${NONE}", &lookup).1[0].1, Source::Unset);
    }

    #[test]
    fn masks_secrets() {
        assert!(is_secret("DISCORD_BOT_TOKEN"));
        assert!(is_secret("api_key"));
        assert!(is_secret("client_secret"));
        assert!(!is_secret("bind"));
        assert_eq!(mask(""), "(空)");
        assert_eq!(mask("short"), "••••");
        assert_eq!(mask("sk-1234567890abcd"), "••••abcd");
        assert_eq!(
            mask_url("postgres://miyoria:hunter2@127.0.0.1:5432/miyoria"),
            "postgres://miyoria:****@127.0.0.1:5432/miyoria"
        );
        assert_eq!(
            display("LLM_API_KEY", "sk-1234567890abcd", false),
            "••••abcd"
        );
        assert_eq!(
            display("LLM_API_KEY", "sk-1234567890abcd", true),
            "sk-1234567890abcd"
        );
    }

    #[test]
    fn changes_are_masked() {
        let dir = temp_dir();
        let path = dir.join("miyoria.toml");
        fs::write(&path, SAMPLE).unwrap();
        fs::write(dir.join(".env"), "LLM_API_KEY=sk-old-0000000000\n").unwrap();
        let mut ws = Workspace::open(&path).unwrap();
        ws.set_env("LLM_API_KEY", "sk-new-1111111111");
        ws.set("modules.api.token", "literal-secret-value").unwrap();
        ws.set("core.profile", "other").unwrap();
        let rendered: Vec<String> = ws.changes().iter().map(Change::render).collect();
        let all = rendered.join("\n");
        assert!(!all.contains("sk-new") && !all.contains("sk-old"), "{all}");
        assert!(!all.contains("literal-secret"), "{all}");
        assert!(all.contains("~ LLM_API_KEY: ••••0000 → ••••1111"), "{all}");
        assert!(
            all.contains("~ core.profile: \"deepseek-chan\" → \"other\""),
            "{all}"
        );
        ws.save().unwrap();
        assert!(ws.changes().is_empty());
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with(
                "# top comment\n[core]\nprofile = \"other\"          # profiles/<id>/"
            )
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn process_env_wins_over_dotenv() {
        let dir = temp_dir();
        let path = dir.join("miyoria.toml");
        fs::write(&path, SAMPLE).unwrap();
        fs::write(dir.join(".env"), "DATABASE_URL=postgres://a@b/c\n").unwrap();
        let ws = Workspace::open(&path).unwrap();
        assert_eq!(
            ws.effective("core.database_url").as_deref(),
            Some("postgres://a@b/c")
        );
        let mut ws = ws.with_process_env(HashMap::from([(
            "DATABASE_URL".to_owned(),
            "memory://".to_owned(),
        )]));
        assert_eq!(
            ws.effective("core.database_url").as_deref(),
            Some("memory://")
        );
        ws.set_env("DATABASE_URL", "postgres://x@y/z");
        assert_eq!(ws.warnings.len(), 1);
        assert_eq!(ws.references("DATABASE_URL"), ["core.database_url"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_config_points_to_init() {
        let dir = temp_dir();
        let err = Workspace::open(&dir.join("miyoria.toml")).err().unwrap();
        assert!(err.to_string().contains("miyoria init"));
        fs::remove_dir_all(dir).unwrap();
    }
}
