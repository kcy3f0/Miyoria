//! CLI commands that talk to a running core through the Admin API.

use futures::StreamExt;
use miyoria_api::ApiClient;
use miyoria_kernel::Config;
use miyoria_types::ModuleStateKind;

/// Client for the core described by `config` (`[modules.api]`).
pub fn client(config: &Config) -> anyhow::Result<ApiClient> {
    let (_, section) = config.module("api");
    let bind = section
        .get("bind")
        .and_then(|v| v.as_str())
        .unwrap_or(miyoria_api::ApiModule::DEFAULT_BIND);
    let token = section
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if token.is_empty() {
        anyhow::bail!("沒有設定 MIYORIA_API_TOKEN(執行 `miyoria init` 產生)");
    }
    // A wildcard bind address is reachable locally through loopback.
    let host = bind
        .replace("0.0.0.0", "127.0.0.1")
        .replace("[::]", "[::1]");
    Ok(ApiClient::new(&format!("http://{host}"), token)?)
}

fn state_label(state: ModuleStateKind) -> &'static str {
    match state {
        ModuleStateKind::Running => "\x1b[32mrunning\x1b[0m",
        ModuleStateKind::Degraded => "\x1b[33mdegraded\x1b[0m",
        ModuleStateKind::Failed => "\x1b[31mfailed\x1b[0m",
        ModuleStateKind::Disabled => "\x1b[90mdisabled\x1b[0m",
        ModuleStateKind::Starting => "starting",
        ModuleStateKind::Stopping => "stopping",
        ModuleStateKind::Stopped => "stopped",
    }
}

pub async fn modules(client: &ApiClient) -> anyhow::Result<()> {
    for m in client.modules().await? {
        let reason = m.reason.map(|r| format!("  ({r})")).unwrap_or_default();
        println!("{:<24} {}{reason}", m.id.as_str(), state_label(m.state));
    }
    Ok(())
}

pub async fn module_action(client: &ApiClient, id: &str, action: &str) -> anyhow::Result<()> {
    let m = client.module_action(id, action).await?;
    println!("{} → {}", m.id.as_str(), state_label(m.state));
    Ok(())
}

pub async fn status(client: &ApiClient) -> anyhow::Result<()> {
    let health = client.health().await?;
    println!("core {}  {}\n", health.version, health.status);
    modules(client).await?;
    let usage = client.usage().await?;
    if !usage.is_empty() {
        println!("\nLLM 用量(啟動以來)");
        for (model, u) in usage {
            println!(
                "  {model}: {} 次,輸入 {}(快取 {}),輸出 {}",
                u.calls, u.prompt_tokens, u.cached_prompt_tokens, u.completion_tokens
            );
        }
    }
    Ok(())
}

pub async fn decisions(client: &ApiClient, limit: usize) -> anyhow::Result<()> {
    for d in client.decisions(limit).await? {
        let t = &d.trace;
        println!(
            "{} {} {:<5} {:.2}  {}  {}",
            d.ts.with_timezone(&chrono::Local).format("%m-%d %H:%M:%S"),
            if t.respond { "回" } else { "略" },
            t.context.channel,
            t.score,
            t.context.platform,
            t.reasons.join(";"),
        );
    }
    Ok(())
}

pub async fn persona_show(client: &ApiClient) -> anyhow::Result<()> {
    for s in client.persona().await? {
        println!(
            "\x1b[36m## {}\x1b[0m({} 字)\n{}\n",
            s.key,
            s.body.chars().count(),
            s.body
        );
    }
    Ok(())
}

pub async fn persona_set(client: &ApiClient, key: &str, body: &str) -> anyhow::Result<()> {
    let version = client.set_persona_as(key, body, Some("cli")).await?;
    println!("✓ `{key}` 已更新為第 {version} 版,下一輪對話生效");
    Ok(())
}

pub async fn events(client: &ApiClient, topics: &[String]) -> anyhow::Result<()> {
    let topics: Vec<&str> = if topics.is_empty() {
        vec!["*"]
    } else {
        topics.iter().map(String::as_str).collect()
    };
    let mut stream = client.events(topics).await?;
    while let Some(env) = stream.next().await {
        let env = env?;
        println!(
            "{} {:<26} {}",
            env.ts.with_timezone(&chrono::Local).format("%H:%M:%S"),
            env.topic(),
            serde_json::to_string(&env.event)?
        );
    }
    Ok(())
}
