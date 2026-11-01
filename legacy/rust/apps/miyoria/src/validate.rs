//! Input validation for config values. Errors are user-facing (zh-TW).
//! Strings holding `${VAR}` references are not checked; their value is.

use toml_edit::Value;

pub type Check = fn(&str) -> Result<(), String>;

fn url_with(s: &str, schemes: &[&str], hint: &str) -> Result<(), String> {
    let s = s.trim();
    if s.contains("${") {
        return Ok(());
    }
    match reqwest::Url::parse(s) {
        Ok(u) if schemes.contains(&u.scheme()) && u.host_str().is_some_and(|h| !h.is_empty()) => {
            Ok(())
        }
        _ => Err(hint.to_owned()),
    }
}

pub fn http_url(s: &str) -> Result<(), String> {
    url_with(
        s,
        &["http", "https"],
        "要是 http:// 或 https:// 開頭的網址,例如 http://127.0.0.1:8001",
    )
}

pub fn ws_url(s: &str) -> Result<(), String> {
    url_with(
        s,
        &["ws", "wss", "http", "https"],
        "要是 ws:// 或 wss:// 開頭的網址,例如 ws://127.0.0.1:7882/stage-link",
    )
}

pub fn database_url(s: &str) -> Result<(), String> {
    let s = s.trim();
    if s == "memory://" || s.contains("${") {
        return Ok(());
    }
    url_with(
        s,
        &["postgres", "postgresql"],
        "要是 memory:// 或 postgres://使用者:密碼@主機:5432/資料庫",
    )
}

pub fn port(s: &str) -> Result<(), String> {
    match s.trim().parse::<u16>() {
        Ok(p) if p > 0 => Ok(()),
        _ => Err("port 要是 1–65535 的整數".to_owned()),
    }
}

pub fn bind(s: &str) -> Result<(), String> {
    let s = s.trim();
    if s.contains("${") {
        return Ok(());
    }
    match s.rsplit_once(':') {
        Some((host, p)) if !host.is_empty() && !host.contains(char::is_whitespace) => {
            port(p).map_err(|_| "格式是 主機:port,例如 127.0.0.1:7878".to_owned())
        }
        _ => Err("格式是 主機:port,例如 127.0.0.1:7878".to_owned()),
    }
}

pub fn discord_id(s: &str) -> Result<(), String> {
    let s = s.trim();
    if (17..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err("Discord id 是 17–20 位數字(開發者模式 → 右鍵 → 複製 ID)".to_owned())
    }
}

pub fn optional_discord_id(s: &str) -> Result<(), String> {
    if s.trim().is_empty() {
        Ok(())
    } else {
        discord_id(s)
    }
}

/// Comma or space separated ids; empty is fine.
pub fn discord_ids(s: &str) -> Result<(), String> {
    s.split([',', ' '])
        .filter(|p| !p.trim().is_empty())
        .try_for_each(discord_id)
}

pub fn model_id(s: &str) -> Result<(), String> {
    let s = s.trim();
    if s.is_empty() {
        Err("模型 id 不能是空的".to_owned())
    } else if s.contains(char::is_whitespace) {
        Err("模型 id 不能有空白".to_owned())
    } else {
        Ok(())
    }
}

pub fn env_name(s: &str) -> Result<(), String> {
    if crate::edit::is_env_name(s) {
        Ok(())
    } else {
        Err(format!(
            "`{s}` 不是合法的環境變數名稱(英數字和底線,例如 LLM_API_KEY)"
        ))
    }
}

/// Checks a value written with `miyoria config set` by its key name.
pub fn value_for_key(path: &[String], value: &Value) -> Result<(), String> {
    let last = path.last().map(String::as_str).unwrap_or_default();
    if value.as_str().is_some_and(|s| s.contains("${")) {
        return Ok(());
    }
    let string = |check: Check| match value.as_str() {
        Some(s) => check(s),
        None => Err(format!("`{last}` 要是字串")),
    };
    match last {
        "enabled" | "dev" if !value.is_bool() => Err(format!("`{last}` 要是 true 或 false")),
        "port" => match value.as_integer() {
            Some(p) if (1..=65535).contains(&p) => Ok(()),
            _ => Err("port 要是 1–65535 的整數".to_owned()),
        },
        "bind" => string(bind),
        "database_url" => string(database_url),
        "core_url" => string(ws_url),
        "command_guilds" => match value.as_array() {
            Some(a) => a.iter().try_for_each(|v| match v.as_str() {
                Some(s) => discord_id(s),
                None => Err("伺服器 id 要用字串,例如 [\"123456789012345678\"]".to_owned()),
            }),
            None => Err("要是陣列,例如 [\"123456789012345678\"]".to_owned()),
        },
        k if k == "url" || k.ends_with("_url") || k.ends_with("_uri") => string(http_url),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{parse_key, parse_value};

    #[test]
    fn urls() {
        assert!(http_url("http://127.0.0.1:8001").is_ok());
        assert!(http_url("https://opencode.ai/inference/go/v1").is_ok());
        assert!(http_url("${ASR_URL:-http://x}").is_ok());
        assert!(http_url("127.0.0.1:8001").is_err());
        assert!(http_url("ftp://x").is_err());
        assert!(http_url("").is_err());
        assert!(ws_url("ws://127.0.0.1:7882/stage-link").is_ok());
        assert!(ws_url("tcp://x").is_err());
        assert!(database_url("memory://").is_ok());
        assert!(database_url("postgres://u:p@127.0.0.1:5432/db").is_ok());
        assert!(database_url("mysql://x").is_err());
    }

    #[test]
    fn numbers_and_ids() {
        assert!(port("4455").is_ok());
        assert!(port("0").is_err());
        assert!(port("70000").is_err());
        assert!(port("abc").is_err());
        assert!(bind("127.0.0.1:7878").is_ok());
        assert!(bind("[::1]:7878").is_ok());
        assert!(bind("7878").is_err());
        assert!(bind(":7878").is_err());
        assert!(discord_id("123456789012345678").is_ok());
        assert!(discord_id("12345").is_err());
        assert!(discord_id("12345678901234567a").is_err());
        assert!(optional_discord_id("").is_ok());
        assert!(discord_ids("123456789012345678, 223456789012345678").is_ok());
        assert!(discord_ids("123456789012345678,x").is_err());
        assert!(model_id("deepseek-chat").is_ok());
        assert!(model_id("qwen2.5:7b").is_ok());
        assert!(model_id("").is_err());
        assert!(model_id("a b").is_err());
        assert!(env_name("LLM_API_KEY").is_ok());
        assert!(env_name("1X").is_err());
    }

    #[test]
    fn values_by_key() {
        let check = |k: &str, v: &str| value_for_key(&parse_key(k).unwrap(), &parse_value(v));
        assert!(check("stage.obs.port", "4455").is_ok());
        assert!(check("stage.obs.port", "\"4455\"").is_err());
        assert!(check("modules.agent.enabled", "false").is_ok());
        assert!(check("modules.agent.enabled", "nope").is_err());
        assert!(check("modules.api.bind", "127.0.0.1:1").is_ok());
        assert!(check("modules.api.bind", "nope").is_err());
        assert!(check("speech.asr.local.url", "http://x:1").is_ok());
        assert!(check("speech.asr.local.url", "x").is_err());
        assert!(check("speech.asr.local.url", "${ASR_URL}").is_ok());
        assert!(check("modules.api.discord_oauth.redirect_uri", "https://a/b").is_ok());
        assert!(check("core.database_url", "memory://").is_ok());
        assert!(check("stage.core_url", "ws://a:1/b").is_ok());
        assert!(
            check(
                r#"modules."platform.discord.bot".command_guilds"#,
                "[\"123456789012345678\"]"
            )
            .is_ok()
        );
        assert!(check(r#"modules."platform.discord.bot".command_guilds"#, "[1]").is_err());
        assert!(check("core.log", "debug").is_ok());
    }
}
