//! `miyoria config`: an interactive menu to change one area at a time, plus
//! `list` / `get` / `set` / `unset` / `edit` for scripts.

use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

use miyoria_api::ApiClient;
use miyoria_kernel::Config;
use toml_edit::Item;

use crate::edit::{self, Change, Source, Target, Workspace, format_key, parse_key, single_ref};
use crate::prompt::{self, Prompter};
use crate::settings::{self, Field, Kind};
use crate::{boot, remote, ui, validate};

// ---- writing -------------------------------------------------------------

fn print_changes(ws: &Workspace, changes: &[Change]) {
    for path in ws.missing_files() {
        println!("  {} 建立 {}", ui::green("+"), path.display());
    }
    for target in [Target::Toml, Target::Env, Target::Profile] {
        let group: Vec<&Change> = changes.iter().filter(|c| c.target == target).collect();
        if group.is_empty() {
            continue;
        }
        if let Some(path) = ws.path_of(target) {
            println!("  {}", ui::bold(path.display()));
        }
        for c in group {
            let line = c.render();
            let colored = match (&c.old, &c.new) {
                (None, _) => ui::green(line),
                (_, None) => ui::red(line),
                _ => ui::yellow(line),
            };
            println!("    {colored}");
        }
    }
}

/// Shows what will change, asks (unless `yes`) and writes. `None` when
/// nothing was written.
pub fn commit(
    p: &mut dyn Prompter,
    yes: bool,
    ws: &mut Workspace,
) -> anyhow::Result<Option<Vec<Change>>> {
    for w in ws.warnings.drain(..) {
        ui::warn(w);
    }
    let changes = ws.changes();
    if changes.is_empty() && ws.missing_files().is_empty() {
        ui::note("沒有變更");
        return Ok(None);
    }
    println!("\n{}", ui::bold("將變更:"));
    print_changes(ws, &changes);
    if !yes && !p.confirm("寫入這些變更?", true)? {
        ui::warn("沒有寫入任何檔案");
        return Ok(None);
    }
    for path in ws.save()? {
        ui::ok(format!("已寫入 {}", path.display()));
    }
    Ok(Some(changes))
}

/// Writes without asking (for `config set` / `unset`).
fn write_now(ws: &mut Workspace) -> anyhow::Result<Vec<Change>> {
    for w in ws.warnings.drain(..) {
        ui::warn(w);
    }
    let changes = ws.changes();
    if changes.is_empty() {
        ui::note("沒有變更");
        return Ok(changes);
    }
    print_changes(ws, &changes);
    for path in ws.save()? {
        ui::ok(format!("已寫入 {}", path.display()));
    }
    Ok(changes)
}

/// The part of the system a config key belongs to.
fn area_of(path: &[String]) -> String {
    match path.first().map(String::as_str) {
        Some("modules") => path.get(1).cloned().unwrap_or_else(|| "modules".into()),
        Some("stage") => "stage 節點".into(),
        Some(first) => first.to_owned(),
        None => String::new(),
    }
}

/// `(module enable/disable toggles, other affected areas)`.
fn classify(ws: &Workspace, changes: &[Change]) -> (Vec<(String, bool)>, BTreeSet<String>) {
    let mut toggles = Vec::new();
    let mut areas = BTreeSet::new();
    for c in changes {
        match c.target {
            Target::Toml => {
                let Ok(path) = parse_key(&c.key) else {
                    continue;
                };
                if path.len() == 3 && path[0] == "modules" && path[2] == "enabled" {
                    toggles.push((path[1].clone(), c.new.as_deref() != Some("false")));
                } else {
                    areas.insert(area_of(&path));
                }
            }
            Target::Env => {
                for key in ws.references(&c.key) {
                    if let Ok(path) = parse_key(&key) {
                        areas.insert(area_of(&path));
                    }
                }
            }
            Target::Profile => {
                areas.insert("角色(profile)".into());
            }
        }
    }
    let toggled: BTreeSet<&String> = toggles.iter().map(|(id, _)| id).collect();
    areas.retain(|a| !toggled.contains(a));
    (toggles, areas)
}

async fn running_core(config_path: &Path) -> Option<ApiClient> {
    let config = Config::load(config_path).ok()?;
    let client = remote::client(&config).ok()?;
    tokio::time::timeout(Duration::from_secs(2), client.health())
        .await
        .ok()?
        .ok()?;
    Some(client)
}

/// After writing: tells what needs a restart and, if a core is running,
/// offers to apply module toggles through the Admin API.
pub async fn after_write(
    p: Option<&mut dyn Prompter>,
    yes: bool,
    ws: &Workspace,
    changes: &[Change],
) -> anyhow::Result<()> {
    let (toggles, areas) = classify(ws, changes);
    if toggles.is_empty() && areas.is_empty() {
        return Ok(());
    }
    let Some(client) = running_core(&ws.config_path).await else {
        ui::note("core 沒有在執行;下次啟動時就會套用。");
        return Ok(());
    };
    if !toggles.is_empty() {
        let list = toggles
            .iter()
            .map(|(id, on)| format!("{}{id}", if *on { "啟用 " } else { "停用 " }))
            .collect::<Vec<_>>()
            .join("、");
        let apply = yes
            || match p {
                Some(p) => p.confirm(&format!("core 正在執行,要現在套用({list})嗎?"), true)?,
                None => false,
            };
        if apply {
            for (id, on) in &toggles {
                let action = if *on { "enable" } else { "disable" };
                if let Err(e) = remote::module_action(&client, id, action).await {
                    ui::fail(format!("{id}:{e:#}"));
                }
            }
        } else {
            ui::note("core 正在執行:用 `miyoria module enable|disable <id>` 立即套用");
        }
    }
    if !areas.is_empty() {
        let list = areas.into_iter().collect::<Vec<_>>().join("、");
        ui::warn(format!(
            "core 正在執行。模組設定在 core 啟動時讀取,這些變更要重啟 core 才會生效:{list}"
        ));
        ui::note(
            "在執行 core 的視窗按 Ctrl+C,再執行 `miyoria core`(Stage 節點則重新執行 `miyoria stage`)",
        );
    }
    Ok(())
}

// ---- interactive menu ----------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Area {
    Profile,
    Llm,
    Discord,
    OAuth,
    Voice,
    Stage,
    Database,
    Owner,
    Tokens,
    Modules,
    Done,
}

const AREAS: &[Area] = &[
    Area::Profile,
    Area::Llm,
    Area::Discord,
    Area::OAuth,
    Area::Voice,
    Area::Stage,
    Area::Database,
    Area::Owner,
    Area::Tokens,
    Area::Modules,
    Area::Done,
];

fn raw_config(ws: &Workspace) -> anyhow::Result<Config> {
    let value: toml::Value = toml::from_str(&ws.doc.to_string())?;
    Ok(Config::from_value(serde_json::to_value(value)?))
}

fn is_set(ws: &Workspace, field: &Field) -> bool {
    !settings::current(ws, field).value.is_empty()
}

fn area_label(area: Area, ws: &mut Workspace) -> String {
    let set = |b: bool| if b { "已設定" } else { "未設定" };
    let (name, status) = match area {
        Area::Profile => (
            "角色(profile)",
            settings::current(ws, &settings::PROFILE).value,
        ),
        Area::Llm => ("LLM", settings::llm_summary(ws)),
        Area::Discord => (
            "Discord bot",
            format!("token {}", set(is_set(ws, &settings::DISCORD_TOKEN))),
        ),
        Area::OAuth => (
            "面板登入(Discord OAuth)",
            if settings::oauth_ready(ws) {
                "已開啟"
            } else {
                "未設定"
            }
            .to_owned(),
        ),
        Area::Voice => ("語音(ASR / TTS worker、voice link)", String::new()),
        Area::Stage => ("Stage(VTube Studio / OBS)", String::new()),
        Area::Database => (
            "資料庫",
            edit::mask_url(&settings::current(ws, &settings::DATABASE).value),
        ),
        Area::Owner => ("擁有者", {
            let v = settings::current(ws, &settings::OWNER).value;
            if v.is_empty() {
                "未設定".to_owned()
            } else {
                v
            }
        }),
        Area::Tokens => ("Tokens(重新產生)", {
            let n = settings::TOKENS
                .iter()
                .filter(|(var, _, _)| ws.lookup(var).is_some_and(|(v, _)| !v.is_empty()))
                .count();
            format!("{n}/{} 已設定", settings::TOKENS.len())
        }),
        Area::Modules => (
            "模組開關",
            match raw_config(ws) {
                Ok(cfg) => {
                    let mods = boot::configured_modules(&cfg);
                    let on = mods.iter().filter(|(_, e)| *e).count();
                    format!("{on}/{} 啟用", mods.len())
                }
                Err(_) => String::new(),
            },
        ),
        Area::Done => ("完成", String::new()),
    };
    if status.is_empty() {
        name.to_owned()
    } else {
        format!("{name}  · {status}")
    }
}

fn modules_area(p: &mut dyn Prompter, ws: &mut Workspace) -> anyhow::Result<()> {
    let mods = boot::configured_modules(&raw_config(ws)?);
    let labels: Vec<String> = mods.iter().map(|(id, _)| id.clone()).collect();
    let defaults: Vec<usize> = mods
        .iter()
        .enumerate()
        .filter(|(_, (_, on))| *on)
        .map(|(i, _)| i)
        .collect();
    let picked = p.multi_select("啟用哪些模組?(空白鍵切換)", &labels, &defaults)?;
    for (i, (id, was)) in mods.iter().enumerate() {
        let now = picked.contains(&i);
        if now == *was {
            continue;
        }
        let key = format!("modules.{}.enabled", format_key(&[id]));
        if now {
            ws.unset(&key)?;
        } else {
            ws.set(&key, false)?;
        }
    }
    Ok(())
}

fn tokens_area(p: &mut dyn Prompter, ws: &mut Workspace) -> anyhow::Result<()> {
    let labels: Vec<String> = settings::TOKENS
        .iter()
        .map(|(var, _, what)| {
            let set = ws.lookup(var).is_some_and(|(v, _)| !v.is_empty());
            format!("{var}  {what}  [{}]", if set { "已設定" } else { "未設定" })
        })
        .collect();
    let (var, _, _) = settings::TOKENS[p.select("重新產生哪一個 token?", &labels, 0)?];
    ui::warn(format!("重新產生 {var} 後,用舊 token 的連線會失效"));
    ws.set_env(var, &settings::new_token());
    ui::note(format!(
        "要給其他節點用時:miyoria config get --env {var} --reveal"
    ));
    Ok(())
}

fn run_area(area: Area, p: &mut dyn Prompter, ws: &mut Workspace) -> anyhow::Result<()> {
    match area {
        Area::Profile => {
            settings::profile_step(p, ws)?;
        }
        Area::Llm => settings::llm_step(p, ws, true)?,
        Area::Discord => {
            settings::edit_fields(p, ws, &[settings::DISCORD_TOKEN, settings::DISCORD_GUILDS])?
        }
        Area::OAuth => settings::oauth_step(p, ws, false)?,
        Area::Voice => {
            settings::edit_fields(p, ws, settings::VOICE)?;
            ui::note("voice link token 在「Tokens」項目");
        }
        Area::Stage => settings::edit_fields(p, ws, settings::STAGE)?,
        Area::Database => settings::database_step(p, ws)?,
        Area::Owner => {
            settings::ask(p, ws, &settings::OWNER)?;
            if ws.references("MIYORIA_OWNER_ID").is_empty() {
                ui::warn(
                    "miyoria.toml 沒有引用 MIYORIA_OWNER_ID([modules.commands] / [modules.auth] 的 owners)",
                );
            }
        }
        Area::Tokens => tokens_area(p, ws)?,
        Area::Modules => modules_area(p, ws)?,
        Area::Done => {}
    }
    Ok(())
}

pub async fn menu(config_path: &Path, p: &mut dyn Prompter, yes: bool) -> anyhow::Result<()> {
    let mut ws = Workspace::open(config_path)?;
    prompt::require_tty()?;
    println!("{}", ui::bold("Miyoria 設定"));
    ui::note("選一個項目修改,只會動到你選的欄位。Esc 返回,選「完成」離開。");
    let mut cursor = 0;
    loop {
        let labels: Vec<String> = AREAS.iter().map(|a| area_label(*a, &mut ws)).collect();
        let pick = match p.select("要設定哪一項?", &labels, cursor) {
            Ok(i) => i,
            Err(e) if prompt::is_cancelled(&e) => break,
            Err(e) => return Err(e),
        };
        cursor = pick;
        let area = AREAS[pick];
        if area == Area::Done {
            break;
        }
        if let Err(e) = run_area(area, p, &mut ws) {
            if prompt::is_cancelled(&e) {
                ui::warn("已取消這一項,沒有寫入");
                ws = Workspace::open(config_path)?;
                continue;
            }
            return Err(e);
        }
        match commit(p, yes, &mut ws)? {
            Some(changes) => after_write(Some(p), yes, &ws, &changes).await?,
            None => ws = Workspace::open(config_path)?,
        }
    }
    Ok(())
}

// ---- scripting commands --------------------------------------------------

fn sources(used: &[(String, Source)]) -> String {
    used.iter()
        .map(|(var, src)| format!("{var}: {}", src.label()))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn list(config_path: &Path, reveal: bool) -> anyhow::Result<()> {
    let ws = Workspace::open(config_path)?;
    println!("{}", ui::bold(config_path.display()));
    let mut referenced = BTreeSet::new();
    for leaf in edit::leaves(ws.doc.as_item()) {
        let key = format_key(&leaf.path);
        let last = leaf.path.last().map(String::as_str).unwrap_or_default();
        let raw = edit::show(&leaf.value);
        match leaf.value.as_str() {
            Some(s) if s.contains("${") => {
                let (value, used) = ws.resolve(s);
                let secret = edit::is_secret(last) || used.iter().any(|(v, _)| edit::is_secret(v));
                referenced.extend(used.iter().map(|(v, _)| v.clone()));
                let shown = if secret && !reveal {
                    edit::mask(&value)
                } else {
                    edit::display("", &value, reveal)
                };
                println!(
                    "{key} = {raw}  {} {shown}  {}",
                    ui::dim("→"),
                    ui::dim(format!("[{}]", sources(&used)))
                );
            }
            Some(s) if edit::is_secret(last) && !reveal => {
                println!(
                    "{key} = \"{}\"  {}",
                    edit::mask(s),
                    ui::yellow("(明文;建議改放 .env)")
                );
            }
            Some(s) if !reveal && s.contains('@') => {
                println!("{key} = \"{}\"", edit::mask_url(s));
            }
            _ => match leaf.value.as_array() {
                Some(items) if raw.contains("${") => {
                    let mut used = Vec::new();
                    let resolved: Vec<String> = items
                        .iter()
                        .map(|v| match v.as_str() {
                            Some(s) => {
                                let (value, u) = ws.resolve(s);
                                used.extend(u);
                                value
                            }
                            None => edit::show(v),
                        })
                        .collect();
                    referenced.extend(used.iter().map(|(v, _)| v.clone()));
                    println!(
                        "{key} = {raw}  {} [{}]  {}",
                        ui::dim("→"),
                        resolved.join(", "),
                        ui::dim(format!("[{}]", sources(&used)))
                    );
                }
                _ => println!("{key} = {raw}"),
            },
        }
    }
    let env = ws.env.entries();
    if !env.is_empty() {
        println!("\n{}", ui::bold(ws.env_path.display()));
        for (name, value) in env {
            let note = if referenced.contains(&name) {
                String::new()
            } else {
                format!("  {}", ui::dim("(miyoria.toml 沒有引用)"))
            };
            println!("{name} = {}{note}", edit::display(&name, &value, reveal));
        }
    }
    Ok(())
}

pub fn get(
    config_path: &Path,
    key: Option<String>,
    env: Option<String>,
    reveal: bool,
) -> anyhow::Result<()> {
    let ws = Workspace::open(config_path)?;
    if let Some(name) = env {
        let (value, src) = ws
            .lookup(&name)
            .ok_or_else(|| anyhow::anyhow!("{name} 沒有設定"))?;
        println!("{}", edit::display(&name, &value, reveal));
        eprintln!("{}", ui::dim(format!("(來源:{})", src.label())));
        return Ok(());
    }
    let key =
        key.ok_or_else(|| anyhow::anyhow!("要指定 key,例如 `miyoria config get core.profile`"))?;
    let path = parse_key(&key)?;
    let item = edit::get(&ws.doc, &path).ok_or_else(|| {
        anyhow::anyhow!("miyoria.toml 沒有 `{key}`(`miyoria config list` 看全部)")
    })?;
    let last = path.last().map(String::as_str).unwrap_or_default();
    match item.as_value() {
        Some(value) => match value.as_str() {
            Some(s) => {
                let (resolved, used) = ws.resolve(s);
                let secret = edit::is_secret(last) || used.iter().any(|(v, _)| edit::is_secret(v));
                println!(
                    "{}",
                    if secret && !reveal {
                        edit::mask(&resolved)
                    } else {
                        edit::display("", &resolved, reveal)
                    }
                );
                if !used.is_empty() {
                    eprintln!(
                        "{}",
                        ui::dim(format!(
                            "(miyoria.toml:{};{})",
                            edit::show(value),
                            sources(&used)
                        ))
                    );
                }
            }
            None => println!("{}", edit::show(value)),
        },
        None => {
            for leaf in edit::leaves(item) {
                let mut full = path.clone();
                full.extend(leaf.path);
                println!("{} = {}", format_key(&full), edit::show(&leaf.value));
            }
        }
    }
    Ok(())
}

/// `.env` variable name for a new secret key, e.g. `stage.obs.password` →
/// `STAGE_OBS_PASSWORD`.
fn env_name_for(path: &[String]) -> String {
    path.iter()
        .filter(|s| *s != "modules")
        .map(|s| {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() {
                        c.to_ascii_uppercase()
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("_")
}

pub async fn set(
    config_path: &Path,
    args: Vec<String>,
    env: Option<String>,
    yes: bool,
) -> anyhow::Result<()> {
    let mut ws = Workspace::open(config_path)?;
    match (env, args.as_slice()) {
        (Some(name), [value]) => {
            validate::env_name(&name).map_err(anyhow::Error::msg)?;
            ws.set_env(&name, value);
            if ws.references(&name).is_empty() {
                ui::warn(format!("miyoria.toml 沒有引用 ${{{name}}}"));
            }
        }
        (Some(_), _) => anyhow::bail!("用法:miyoria config set --env NAME <值>"),
        (None, [key, value]) => {
            let path = parse_key(key)?;
            let shown = format_key(&path);
            let current = edit::get(&ws.doc, &path);
            if current.is_some_and(|i| i.is_table_like()) {
                anyhow::bail!("`{shown}` 是表格;要指定其中的鍵,例如 `{shown}.enabled`");
            }
            let reference = current
                .and_then(Item::as_str)
                .and_then(single_ref)
                .map(|r| r.name.to_owned());
            let last = path.last().map(String::as_str).unwrap_or_default();
            if let Some(var) = reference.filter(|_| !value.contains("${")) {
                // Keep `${VAR}` in miyoria.toml; the value goes to .env.
                ws.set_env(&var, value);
                ui::note(format!("{shown} 引用 ${{{var}}},改寫 .env 的 {var}"));
            } else if edit::is_secret(last) && !value.contains("${") {
                let known = settings::all_fields().into_iter().find(|f| {
                    f.key
                        .is_some_and(|k| parse_key(k).ok().as_ref() == Some(&path))
                });
                let var = known
                    .and_then(|f| f.env)
                    .map(str::to_owned)
                    .unwrap_or_else(|| env_name_for(&path));
                let field = Field::toml("", &shown, Kind::Secret).env(&var);
                settings::apply(&mut ws, &field, value)?;
                ui::note(format!("密碼類的值放在 .env 的 {var},miyoria.toml 引用它"));
            } else {
                let parsed = edit::parse_value(value);
                validate::value_for_key(&path, &parsed)
                    .map_err(|e| anyhow::anyhow!("`{shown}`:{e}"))?;
                edit::set(&mut ws.doc, &path, parsed)?;
            }
        }
        (None, _) => anyhow::bail!("用法:miyoria config set <key> <值>"),
    }
    let changes = write_now(&mut ws)?;
    after_write(None, yes, &ws, &changes).await
}

pub async fn unset(
    config_path: &Path,
    key: Option<String>,
    env: Option<String>,
    yes: bool,
) -> anyhow::Result<()> {
    let mut ws = Workspace::open(config_path)?;
    match (key, env) {
        (None, Some(name)) => {
            if !ws.env.unset(&name) {
                anyhow::bail!(".env 沒有 {name}");
            }
        }
        (Some(key), None) => {
            if !ws.unset(&key)? {
                anyhow::bail!("miyoria.toml 沒有 `{key}`");
            }
        }
        _ => anyhow::bail!("用法:miyoria config unset <key>  或  miyoria config unset --env NAME"),
    }
    let changes = write_now(&mut ws)?;
    after_write(None, yes, &ws, &changes).await
}

pub async fn edit(config_path: &Path, yes: bool) -> anyhow::Result<()> {
    let before = Workspace::open(config_path)?;
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .ok()
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| if cfg!(windows) { "notepad" } else { "vi" }.to_owned());
    // `EDITOR="code -w"` style values carry arguments; a plain path may have spaces.
    let (program, args): (String, Vec<&str>) = if Path::new(&editor).exists() {
        (editor.clone(), Vec::new())
    } else {
        let mut parts = editor.split_whitespace();
        (
            parts.next().unwrap_or("notepad").to_owned(),
            parts.collect(),
        )
    };
    ui::note(format!(
        "用 {program} 開啟 {}(關掉編輯器後繼續)",
        config_path.display()
    ));
    let status = std::process::Command::new(&program)
        .args(args)
        .arg(config_path)
        .status()
        .map_err(|e| anyhow::anyhow!("無法啟動編輯器 `{program}`:{e}(設定 EDITOR 環境變數)"))?;
    if !status.success() {
        anyhow::bail!("編輯器結束時回報錯誤({status})");
    }
    let text = std::fs::read_to_string(config_path)?;
    let doc = match text.parse::<toml_edit::DocumentMut>() {
        Ok(doc) => doc,
        Err(e) => {
            anyhow::bail!(
                "{} 不是合法的 TOML,請再執行 `miyoria config edit` 修正:\n{e}",
                config_path.display()
            )
        }
    };
    let changes = edit::diff_toml(&before.doc.to_string(), &doc, Target::Toml);
    if changes.is_empty() {
        ui::note("沒有變更");
        return Ok(());
    }
    let after = Workspace::open(config_path)?;
    print_changes(&after, &changes);
    ui::ok(format!("{} 格式正確", config_path.display()));
    after_write(None, yes, &after, &changes).await
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::edit::tests::temp_dir;
    use crate::init::EXAMPLE_CONFIG;
    use crate::prompt::scripted::{Answer::*, Scripted};

    #[test]
    fn env_names_for_new_secrets() {
        let path = parse_key(r#"modules."platform.x".api_key"#).unwrap();
        assert_eq!(env_name_for(&path), "PLATFORM_X_API_KEY");
    }

    #[test]
    fn classifies_restarts() {
        let dir = temp_dir();
        let config = dir.join("miyoria.toml");
        fs::write(&config, EXAMPLE_CONFIG).unwrap();
        let ws = Workspace::open(&config).unwrap();
        let change = |target, key: &str, new: Option<&str>| Change {
            target,
            key: key.into(),
            old: None,
            new: new.map(Into::into),
        };
        let (toggles, areas) = classify(
            &ws,
            &[
                change(Target::Toml, "modules.agent.enabled", Some("false")),
                change(Target::Toml, "modules.memory.enabled", None),
                change(Target::Toml, "speech.tts.local.voice", Some("\"x\"")),
                change(Target::Env, "MIYORIA_OWNER_ID", Some("1")),
                change(Target::Env, "STAGE_LINK_TOKEN", Some("1")),
            ],
        );
        assert_eq!(
            toggles,
            [("agent".to_owned(), false), ("memory".to_owned(), true)]
        );
        let areas: Vec<&str> = areas.iter().map(String::as_str).collect();
        assert_eq!(
            areas,
            ["auth", "commands", "speech", "stage 節點", "stage.link"]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn menu_areas_edit_only_picked_fields() {
        let dir = temp_dir();
        let config = dir.join("miyoria.toml");
        fs::write(&config, EXAMPLE_CONFIG).unwrap();
        fs::write(dir.join(".env"), "OBS_PASSWORD=old-password-123\n").unwrap();
        let mut ws = Workspace::open(&config).unwrap();
        // Stage: pick OBS port (5) and enable OBS (3).
        let mut p = Scripted::new([Picks(vec![3, 5]), Yes, Text("4456")]);
        run_area(Area::Stage, &mut p, &mut ws).unwrap();
        let keys: Vec<String> = ws.changes().iter().map(Change::render).collect();
        assert_eq!(
            keys,
            [
                "~ stage.obs.enabled: false → true",
                "~ stage.obs.port: 4455 → 4456"
            ]
        );

        // Modules: turn off agent.
        let mods = boot::configured_modules(&raw_config(&ws).unwrap());
        let keep: Vec<usize> = (0..mods.len()).filter(|i| mods[*i].0 != "agent").collect();
        let mut p = Scripted::new([Picks(keep)]);
        run_area(Area::Modules, &mut p, &mut ws).unwrap();
        assert!(
            ws.doc
                .to_string()
                .contains("[modules.agent]\nenabled = false\n")
        );
        ws.save().unwrap();
        let text = fs::read_to_string(&config).unwrap();
        assert!(
            text.contains("password = \"${OBS_PASSWORD:-}\""),
            "secret reference untouched"
        );
        assert!(text.contains("port = 4456\n"));
        fs::remove_dir_all(dir).unwrap();
    }
}
