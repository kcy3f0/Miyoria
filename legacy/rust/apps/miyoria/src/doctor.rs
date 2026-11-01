//! `miyoria doctor`: checks everything needed to run, one line per check.

use std::path::Path;
use std::time::Instant;

use miyoria_kernel::Config;
use miyoria_llm::{ChatMessage, ChatRequest};

use crate::boot;

/// Discord application flags for the message content intent.
const GATEWAY_MESSAGE_CONTENT: u64 = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED: u64 = 1 << 19;

pub async fn run(config_path: &Path) -> anyhow::Result<()> {
    let mut failures = 0;
    let mut report = |ok: bool, what: &str, detail: String| {
        if ok {
            println!("\x1b[32m✓\x1b[0m {what}  {detail}");
        } else {
            failures += 1;
            println!("\x1b[31m✗\x1b[0m {what}  {detail}");
        }
    };

    let config = match Config::load(config_path) {
        Ok(c) => {
            report(true, "設定檔", config_path.display().to_string());
            c
        }
        Err(e) => {
            report(false, "設定檔", format!("{e}(先執行 `miyoria init`)"));
            anyhow::bail!("無法繼續檢查");
        }
    };

    let profile = match boot::load_profile(&config) {
        Ok(p) => {
            report(
                true,
                "角色",
                format!("{}({} 個人格段落)", p.display_name(), p.sections.len()),
            );
            Some(p)
        }
        Err(e) => {
            report(false, "角色", format!("{e:#}"));
            None
        }
    };

    if let Some(profile) = &profile {
        match boot::llm_module(&config, profile).and_then(|m| m.build_router()) {
            Ok(router) => {
                let chain = router.chain("chat");
                let request = ChatRequest {
                    messages: vec![ChatMessage::user("請只回答 OK")],
                    max_tokens: Some(16),
                    ..Default::default()
                };
                let started = Instant::now();
                match router.complete("chat", request).await {
                    Ok(resp) => report(
                        true,
                        "LLM",
                        format!(
                            "{} 回應「{}」,{} ms",
                            chain.first().map(ToString::to_string).unwrap_or_default(),
                            resp.text.trim(),
                            started.elapsed().as_millis()
                        ),
                    ),
                    Err(e) => report(false, "LLM", format!("{e:#}")),
                }
            }
            Err(e) => report(false, "LLM", format!("{e:#}")),
        }
    }

    let (discord_enabled, discord) = config.module("platform.discord.bot");
    let token = discord
        .get("token")
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    if !discord_enabled {
        report(true, "Discord", "已停用".into());
    } else if token.is_empty() {
        report(false, "Discord", "沒有設定 DISCORD_BOT_TOKEN".into());
    } else {
        match check_discord(token).await {
            Ok(detail) => report(true, "Discord", detail),
            Err(e) => report(false, "Discord", format!("{e:#}")),
        }
    }

    let url = boot::database_url(&config);
    match miyoria_store::Store::from_url(&url).await {
        Ok(_) => report(true, "資料庫", redact_url(&url)),
        Err(e) => report(false, "資料庫", format!("{}:{e:#}", redact_url(&url))),
    }

    if failures > 0 {
        anyhow::bail!("{failures} 項檢查失敗");
    }
    println!("\n全部正常!");
    Ok(())
}

async fn check_discord(token: &str) -> anyhow::Result<String> {
    let client = reqwest::Client::new();
    let app: serde_json::Value = client
        .get("https://discord.com/api/v10/applications/@me")
        .header("Authorization", format!("Bot {token}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let name = app["bot"]["username"]
        .as_str()
        .or_else(|| app["name"].as_str())
        .unwrap_or("?");
    let flags = app["flags"].as_u64().unwrap_or(0);
    if flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED) == 0 {
        anyhow::bail!(
            "bot `{name}` 沒有開啟 Message Content Intent(Developer Portal → Bot → Privileged Gateway Intents)"
        );
    }
    Ok(format!("bot `{name}`"))
}

fn redact_url(url: &str) -> String {
    match (url.find("://"), url.rfind('@')) {
        (Some(scheme), Some(at)) if at > scheme => {
            format!("{}://***{}", &url[..scheme], &url[at..])
        }
        _ => url.to_owned(),
    }
}
