//! `miyoria init`: guided setup. Safe to re-run: every question defaults to
//! the current value, secrets are only replaced when typed, existing tokens
//! are kept, missing files start from the bundled examples, and nothing is
//! written before the summary is confirmed.

use std::path::Path;

use crate::config_cmd;
use crate::edit::Workspace;
use crate::prompt::Prompter;
use crate::settings;
use crate::ui;

pub const EXAMPLE_CONFIG: &str = include_str!("../../../miyoria.example.toml");
pub const EXAMPLE_ENV: &str = include_str!("../../../.env.example");

pub async fn run(config_path: &Path, p: &mut dyn Prompter, yes: bool) -> anyhow::Result<()> {
    let mut ws = Workspace::open_or_create(config_path, EXAMPLE_CONFIG, EXAMPLE_ENV)?;
    println!("{}", ui::bold("Miyoria 設定精靈"));
    if ws.toml_exists() {
        ui::note("已讀取現有設定:每一題直接按 Enter 會保留目前的值;密碼類欄位不輸入就不會改。");
    } else {
        ui::note(format!("會從範例建立 {}。", config_path.display()));
    }

    let generated = flow(p, &mut ws)?;
    if !generated.is_empty() {
        ui::note(format!("會產生新的 token:{}", generated.join("、")));
    }
    if let Some(changes) = config_cmd::commit(p, yes, &mut ws)? {
        config_cmd::after_write(Some(p), yes, &ws, &changes).await?;
    }

    println!(
        "\n下一步:\n  miyoria doctor   檢查連線\n  miyoria chat     在終端機跟她聊天\n  miyoria core     啟動 Discord bot\n  miyoria config   之後要改單一項目用這個"
    );
    Ok(())
}

/// All questions, editing `ws` in memory. Returns the generated tokens.
pub fn flow(p: &mut dyn Prompter, ws: &mut Workspace) -> anyhow::Result<Vec<&'static str>> {
    ui::section("角色");
    settings::profile_step(p, ws)?;

    ui::section("LLM");
    settings::llm_step(p, ws, false)?;

    ui::section("Discord");
    settings::ask(p, ws, &settings::DISCORD_TOKEN)?;
    settings::ask(p, ws, &settings::OWNER)?;

    ui::section("資料庫");
    settings::database_step(p, ws)?;

    ui::section("管理面板");
    settings::oauth_step(p, ws, true)?;

    settings::ensure_tokens(ws)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::edit::tests::temp_dir;
    use crate::prompt::scripted::{Answer::*, Scripted};

    const ENV: &str = "\
# my env
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-existing-1234567890
DISCORD_BOT_TOKEN='bot.token.value'
MIYORIA_OWNER_ID=123456789012345678
MIYORIA_API_TOKEN=keepme-api
VOICE_LINK_TOKEN=keepme-voice
STAGE_LINK_TOKEN=keepme-stage
DATABASE_URL=memory://
";

    const PROFILE: &str = "\
id = \"deepseek-chan\"

[llm.purposes]
chat       = [\"deepseek:deepseek-v4\"]   # main
fast       = [\"deepseek:deepseek-v4\"]
";

    /// A configured install: example config, filled .env, one profile.
    fn setup() -> (PathBuf, PathBuf) {
        let dir = temp_dir();
        let config = dir.join("miyoria.toml");
        fs::write(&config, EXAMPLE_CONFIG).unwrap();
        fs::write(dir.join(".env"), ENV).unwrap();
        let profile = dir.join("profiles/deepseek-chan");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("profile.toml"), PROFILE).unwrap();
        (dir, config)
    }

    #[test]
    fn rerun_with_enter_keeps_everything() {
        let (dir, config) = setup();
        let mut ws = Workspace::open(&config).unwrap();
        // profile, kind, base URL, API key, model, bot token, owner, db, OAuth?
        let mut p = Scripted::new([Enter, Enter, Enter, Enter, Enter, Enter, Enter, Enter, No]);
        let generated = flow(&mut p, &mut ws).unwrap();
        assert!(p.done());
        assert!(generated.is_empty(), "tokens must not be regenerated");
        assert!(ws.changes().is_empty(), "{:?}", ws.changes());
        assert!(
            p.asked
                .iter()
                .any(|q| q.starts_with("LLM API key") && q.contains("已設定(按 Enter 保留)")),
            "{:?}",
            p.asked
        );
        assert!(
            p.asked
                .iter()
                .any(|q| q.contains("Discord bot token") && q.contains("已設定"))
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changes_only_what_was_typed() {
        let (dir, config) = setup();
        let mut ws = Workspace::open(&config).unwrap();
        let mut p = Scripted::new([
            Enter,
            Enter,
            Enter,
            Text("sk-new-key-0987654321"),
            Text("deepseek-v5"),
            Enter,
            Enter,
            Enter,
            No,
        ]);
        flow(&mut p, &mut ws).unwrap();
        let keys: Vec<String> = ws.changes().iter().map(|c| c.key.clone()).collect();
        assert_eq!(
            keys,
            ["LLM_API_KEY", "llm.purposes.chat", "llm.purposes.fast"]
        );
        ws.save().unwrap();
        let env = fs::read_to_string(dir.join(".env")).unwrap();
        assert!(env.starts_with("# my env\n"));
        assert!(env.contains("LLM_API_KEY=sk-new-key-0987654321\n"));
        assert!(env.contains("DISCORD_BOT_TOKEN='bot.token.value'\n"));
        assert!(env.contains("MIYORIA_API_TOKEN=keepme-api\n"));
        let profile = fs::read_to_string(dir.join("profiles/deepseek-chan/profile.toml")).unwrap();
        assert!(
            profile.contains("chat       = [\"deepseek:deepseek-v5\"]   # main"),
            "{profile}"
        );
        assert!(profile.contains("fast       = [\"deepseek:deepseek-v5\"]"));
        // The config file keeps its references.
        let toml = fs::read_to_string(&config).unwrap();
        assert_eq!(toml, EXAMPLE_CONFIG);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opencode_and_oauth_are_added() {
        let (dir, config) = setup();
        let mut ws = Workspace::open(&config).unwrap();
        let opencode = settings::LLM_KINDS
            .iter()
            .position(|k| *k == "opencode")
            .unwrap();
        let mut p = Scripted::new([
            Enter,          // profile
            Pick(opencode), // kind
            Enter,          // base URL: opencode default
            Text("oc-key-1234567890"),
            Text("kimi-k2"),
            Enter,
            Enter,
            Enter,
            Yes, // OAuth
            Text("223456789012345678"),
            Text("oauth-secret-1234567890"),
            Enter, // redirect default
        ]);
        flow(&mut p, &mut ws).unwrap();
        assert!(p.done());
        ws.save().unwrap();
        let toml = fs::read_to_string(&config).unwrap();
        assert!(toml.contains(
            "[llm.providers.opencode]\nkind = \"opencode\"\nbase_url = \"https://opencode.ai/inference/go/v1\"\napi_key = \"${OPENCODE_API_KEY:-}\"\n"
        ), "{toml}");
        assert!(toml.contains(
            "[modules.api.discord_oauth]\nclient_id = \"${DISCORD_CLIENT_ID:-}\"\nclient_secret = \"${DISCORD_CLIENT_SECRET:-}\"\nredirect_uri = \"http://127.0.0.1:7878/api/auth/oauth/callback\"\n"
        ), "{toml}");
        // The old provider and its comment stay.
        assert!(
            toml.contains(
                "[llm.providers.deepseek]\nkind = \"deepseek\"                  # deepseek"
            )
        );
        let env = fs::read_to_string(dir.join(".env")).unwrap();
        assert!(env.contains("OPENCODE_API_KEY=oc-key-1234567890\n"));
        assert!(env.contains("DISCORD_CLIENT_ID=223456789012345678\n"));
        assert!(env.contains("DISCORD_CLIENT_SECRET=oauth-secret-1234567890\n"));
        assert!(env.contains("LLM_API_KEY=sk-existing-1234567890\n"));
        let profile = fs::read_to_string(dir.join("profiles/deepseek-chan/profile.toml")).unwrap();
        assert!(
            profile.contains("chat       = [\"opencode:kimi-k2\"]"),
            "{profile}"
        );

        // Running again with Enter everywhere keeps the new setup.
        let mut ws = Workspace::open(&config).unwrap();
        let mut p = Scripted::new([
            Enter, Enter, Enter, Enter, Enter, Enter, Enter, Enter, Enter, Enter, Enter, Enter,
        ]);
        flow(&mut p, &mut ws).unwrap();
        assert!(p.done(), "{:?}", p.asked);
        assert!(ws.changes().is_empty(), "{:?}", ws.changes());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fresh_directory_starts_from_the_examples() {
        let dir = temp_dir();
        let config = dir.join("miyoria.toml");
        let mut ws = Workspace::open_or_create(&config, EXAMPLE_CONFIG, EXAMPLE_ENV).unwrap();
        // No profiles dir: the profile is asked as text.
        let mut p = Scripted::new([
            Enter,
            Enter,
            Enter,
            Text("sk-fresh-1234567890"),
            Enter,
            Enter,
            Enter,
            Pick(1),
            Enter,
            No,
        ]);
        let generated = flow(&mut p, &mut ws).unwrap();
        assert_eq!(generated.len(), 3);
        assert_eq!(ws.missing_files().len(), 2);
        ws.save().unwrap();
        let env = fs::read_to_string(dir.join(".env")).unwrap();
        assert!(env.contains("LLM_API_KEY=sk-fresh-1234567890\n"));
        assert!(env.contains(&format!(
            "DATABASE_URL={}\n",
            settings::DEFAULT_POSTGRES_URL
        )));
        let token = |text: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix("MIYORIA_API_TOKEN="))
                .unwrap()
                .to_owned()
        };
        let first = token(&env);
        assert_eq!(first.len(), 52);

        // A second run keeps the generated token.
        let mut ws = Workspace::open(&config).unwrap();
        let mut p = Scripted::new([
            Enter, Enter, Enter, Enter, Enter, Enter, Enter, Enter, Enter, No,
        ]);
        assert!(flow(&mut p, &mut ws).unwrap().is_empty());
        assert!(ws.changes().is_empty(), "{:?}", ws.changes());
        ws.save().unwrap();
        assert_eq!(token(&fs::read_to_string(dir.join(".env")).unwrap()), first);
        fs::remove_dir_all(dir).unwrap();
    }
}
