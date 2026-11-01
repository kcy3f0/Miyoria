//! `miyoria init`: interactive first-time setup. Secrets go to `.env`,
//! everything else to `miyoria.toml`.

use std::fs;
use std::path::Path;

use anyhow::Context;
use inquire::{Confirm, Password, PasswordDisplayMode, Select, Text};

const EXAMPLE_CONFIG: &str = include_str!("../../../miyoria.example.toml");

pub fn run(config_path: &Path) -> anyhow::Result<()> {
    println!("Miyoria 設定精靈\n");
    let dir = config_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));

    if config_path.exists()
        && !Confirm::new(&format!("{} 已存在,要覆寫嗎?", config_path.display()))
            .with_default(false)
            .prompt()?
    {
        println!("保留現有設定,只更新 .env。");
    } else {
        let kind = Select::new(
            "LLM API 類型",
            vec!["deepseek", "openai-compatible", "openai"],
        )
        .prompt()?;
        let config = EXAMPLE_CONFIG.replace(
            "kind = \"deepseek\"                  # deepseek | openai | openai-compatible",
            &format!("kind = \"{kind}\"                  # deepseek | openai | openai-compatible"),
        );
        fs::write(config_path, config)
            .with_context(|| format!("writing {}", config_path.display()))?;
        println!("✓ 已寫入 {}", config_path.display());
    }

    let base_url = Text::new("LLM base URL")
        .with_default("https://api.deepseek.com")
        .prompt()?;
    let api_key = secret("LLM API key")?;
    let model = Text::new("模型 id(會寫進角色的 profile.toml)")
        .with_default("deepseek-chat")
        .prompt()?;
    let discord_token = secret("Discord bot token(可留空,之後再填)")?;
    let owner_id = Text::new("你的 Discord user id(擁有者權限,可留空)")
        .with_default("")
        .prompt()?;
    let database = Select::new(
        "資料庫",
        vec![
            "memory://(不保存,先試用)",
            "PostgreSQL(用 deploy/docker-compose.yml)",
        ],
    )
    .prompt()?;
    let database_url = if database.starts_with("memory") {
        "memory://".to_owned()
    } else {
        Text::new("DATABASE_URL")
            .with_default("postgres://miyoria:miyoria@127.0.0.1:5432/miyoria")
            .prompt()?
    };

    let env_path = dir.join(".env");
    let mut env = fs::read_to_string(&env_path).unwrap_or_default();
    for (key, value) in [
        ("LLM_BASE_URL", base_url.as_str()),
        ("LLM_API_KEY", api_key.as_str()),
        ("DISCORD_BOT_TOKEN", discord_token.as_str()),
        ("MIYORIA_OWNER_ID", owner_id.as_str()),
        ("DATABASE_URL", database_url.as_str()),
    ] {
        if !value.is_empty() || !env.contains(&format!("{key}=")) {
            env = upsert_env(&env, key, value);
        }
    }
    if !env.contains("MIYORIA_API_TOKEN=")
        || env.contains(
            "MIYORIA_API_TOKEN=
",
        )
    {
        // Two ULIDs = 160 random bits; only used to authenticate the local CLI / panel.
        let token = format!("{}{}", ulid::Ulid::new(), ulid::Ulid::new()).to_lowercase();
        env = upsert_env(&env, "MIYORIA_API_TOKEN", &token);
    }
    fs::write(&env_path, env).with_context(|| format!("writing {}", env_path.display()))?;
    println!("✓ 已寫入 {}(不會進 git)", env_path.display());

    let profile_path = dir.join("profiles/deepseek-chan/profile.toml");
    if model != "deepseek-chat" && profile_path.exists() {
        let text = fs::read_to_string(&profile_path)?;
        fs::write(
            &profile_path,
            text.replace("deepseek:deepseek-chat", &format!("deepseek:{model}")),
        )?;
        println!("✓ 已把 {} 的模型改成 {model}", profile_path.display());
    }

    println!(
        "\n下一步:\n  miyoria doctor   檢查連線\n  miyoria chat     在終端機跟她聊天\n  miyoria core     啟動 Discord bot"
    );
    Ok(())
}

fn secret(prompt: &str) -> anyhow::Result<String> {
    Ok(Password::new(prompt)
        .without_confirmation()
        .with_display_mode(PasswordDisplayMode::Masked)
        .prompt()?)
}

/// Sets `key=value` in dotenv text, replacing an existing line.
fn upsert_env(text: &str, key: &str, value: &str) -> String {
    let prefix = format!("{key}=");
    let mut found = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|line| {
            if line.trim_start().starts_with(&prefix) {
                found = true;
                format!("{key}={value}")
            } else {
                line.to_owned()
            }
        })
        .collect();
    if !found {
        lines.push(format!("{key}={value}"));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::upsert_env;

    #[test]
    fn upserts_env_lines() {
        let text = "# c\nA=1\nB=2\n";
        assert_eq!(upsert_env(text, "B", "3"), "# c\nA=1\nB=3\n");
        assert_eq!(upsert_env(text, "C", "x"), "# c\nA=1\nB=2\nC=x\n");
    }
}
