mod boot;
mod cli_platform;
mod config_cmd;
mod doctor;
mod edit;
mod init;
mod prompt;
mod remote;
mod settings;
mod ui;
mod validate;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Arg, ArgAction, CommandFactory, FromArgMatches, Parser, Subcommand};
use miyoria_kernel::Config;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "miyoria", version, about = "Miyoria — AI waifu 框架")]
struct Cli {
    /// miyoria.toml 的路徑
    #[arg(long, short, global = true, default_value = "miyoria.toml")]
    config: PathBuf,

    /// 跳過所有確認,直接寫入 / 套用
    #[arg(long, short = 'y', global = true)]
    yes: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 設定精靈:LLM、Discord、資料庫、面板登入;可重複執行,Enter 保留現值
    Init,
    /// 修改設定(不帶子指令時開互動選單,一次改一項)
    Config {
        #[command(subcommand)]
        command: Option<ConfigCommand>,
    },
    /// 檢查設定檔、角色、LLM、Discord 和資料庫連線
    Doctor,
    /// 啟動 core 節點(Discord bot、agent ...)
    Core,
    /// 在直播機啟動 stage 節點(VTube Studio、OBS、overlay)
    Stage,
    /// 在終端機跟她聊天(不需要 Discord)
    Chat {
        /// 你在對話裡的名字
        #[arg(long, default_value = "你")]
        name: String,
        /// 聊天時也連上 Discord bot
        #[arg(long)]
        with_discord: bool,
    },
    /// 執行中 core 的狀態:模組和 LLM 用量
    Status,
    /// 管理執行中 core 的模組
    Module {
        #[command(subcommand)]
        command: ModuleCommand,
    },
    /// 最近的注意力決策(她為什麼回話或保持安靜)
    Decisions {
        /// 顯示幾筆
        #[arg(long, short, default_value_t = 20)]
        limit: usize,
    },
    /// 即時追蹤 core 的事件,例如 `miyoria events 'agent.*'`
    Events {
        /// 事件主題(可用萬用字元,省略 = 全部)
        topics: Vec<String>,
    },
    /// 執行中 core 的人格段落
    Persona {
        #[command(subcommand)]
        command: PersonaCommand,
    },
    /// 角色工具(離線)
    Profile {
        #[command(subcommand)]
        command: ProfileCommand,
    },
    /// 擴充套件(離線工具,`dev` 會以熱重載啟動 core)
    Ext {
        #[command(subcommand)]
        command: ExtCommand,
    },
}

#[derive(Subcommand)]
enum ConfigCommand {
    /// 列出所有設定和實際值(密碼遮蔽,標示哪些來自 .env)
    List {
        /// 顯示密碼原文
        #[arg(long)]
        reveal: bool,
    },
    /// 顯示一個設定的實際值,例如 `core.profile`
    Get {
        /// 以點分隔的鍵,例如 modules.api.bind 或 'modules."voice.link".bind'
        key: Option<String>,
        /// 改讀 .env 的變數
        #[arg(long, value_name = "NAME", conflicts_with = "key")]
        env: Option<String>,
        /// 顯示密碼原文
        #[arg(long)]
        reveal: bool,
    },
    /// 設定一個值,例如 `set core.log debug`;引用 ${VAR} 的鍵會改寫 .env
    Set {
        /// 改寫 .env 的變數:`set --env LLM_API_KEY sk-...`
        #[arg(long, value_name = "NAME")]
        env: Option<String>,
        /// <key> <值>(值用 TOML 解析:3、true、["a"];其他當字串)
        #[arg(
            required = true,
            num_args = 1..=2,
            value_name = "KEY 值",
            allow_hyphen_values = true
        )]
        args: Vec<String>,
    },
    /// 刪除一個設定(或 `--env NAME` 刪除 .env 變數)
    Unset {
        /// 以點分隔的鍵
        key: Option<String>,
        /// 刪除 .env 的變數
        #[arg(long, value_name = "NAME", conflicts_with = "key")]
        env: Option<String>,
    },
    /// 用編輯器開啟 miyoria.toml($VISUAL / $EDITOR,Windows 預設記事本)
    Edit,
}

#[derive(Subcommand)]
enum ExtCommand {
    /// 建立 TypeScript 擴充套件骨架
    New {
        /// 套件名稱
        name: String,
        /// 上層資料夾
        #[arg(long, default_value = "extensions")]
        dir: PathBuf,
    },
    /// 列出找到的擴充套件
    List,
    /// 從本機路徑或 git URL 安裝
    Install {
        /// 路徑或 git URL
        source: String,
    },
    /// 檢查擴充套件的 manifest
    Validate {
        /// 擴充套件資料夾
        dir: PathBuf,
    },
    /// 以擴充套件熱重載啟動 core
    Dev,
}

#[derive(Subcommand)]
enum ModuleCommand {
    /// 列出模組(core 沒在執行時顯示設定檔內容)
    List,
    /// 啟用模組
    Enable {
        /// 模組 id
        id: String,
    },
    /// 停用模組
    Disable {
        /// 模組 id
        id: String,
    },
    /// 重新啟動模組
    Restart {
        /// 模組 id
        id: String,
    },
}

#[derive(Subcommand)]
enum PersonaCommand {
    /// 顯示所有人格段落
    Show,
    /// 用檔案內容取代一個段落(`-` 代表 stdin)
    Set {
        /// 段落名稱
        key: String,
        /// 檔案路徑或 `-`
        file: PathBuf,
    },
}

#[derive(Subcommand)]
enum ProfileCommand {
    /// 載入並檢查目前的角色
    Validate,
}

const HELP_TEMPLATE: &str =
    "{before-help}{about-with-newline}\n用法:{usage}\n\n{all-args}{after-help}";

/// Traditional Chinese help: headings and `-h` / `-V` texts on every subcommand.
fn localize(cmd: clap::Command, root: bool) -> clap::Command {
    let mut cmd = cmd
        .help_template(HELP_TEMPLATE)
        .subcommand_help_heading("指令")
        .subcommand_value_name("指令")
        .disable_help_subcommand(true)
        .disable_help_flag(true)
        .mut_args(|a| {
            let heading = if a.is_positional() {
                "參數"
            } else {
                "選項"
            };
            a.help_heading(heading)
        })
        .arg(
            Arg::new("help")
                .short('h')
                .long("help")
                .action(ArgAction::Help)
                .help("顯示說明")
                .help_heading("選項"),
        );
    if root {
        cmd = cmd.disable_version_flag(true).arg(
            Arg::new("version")
                .short('V')
                .long("version")
                .action(ArgAction::Version)
                .help("顯示版本")
                .help_heading("選項"),
        );
    }
    cmd.mut_subcommands(|sub| localize(sub, false))
}

fn load_config(path: &Path) -> anyhow::Result<Config> {
    if !path.exists() {
        anyhow::bail!("找不到 {}:先執行 `miyoria init` 建立設定", path.display());
    }
    Ok(Config::load(path)?)
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if prompt::is_cancelled(&e) || prompt::is_interrupted(&e) => {
            ui::warn(e);
            ExitCode::from(130)
        }
        Err(e) => {
            ui::fail(format!("{e:#}"));
            ExitCode::FAILURE
        }
    }
}

async fn run() -> anyhow::Result<()> {
    let matches = localize(Cli::command(), true).get_matches();
    let cli = Cli::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());
    edit::capture_process_env();
    load_dotenv(&cli.config);
    let mut prompter = prompt::Inquire;

    match cli.command {
        Command::Init => {
            prompt::require_tty()?;
            init::run(&cli.config, &mut prompter, cli.yes).await
        }
        Command::Config { command } => {
            let path = &cli.config;
            match command {
                None => config_cmd::menu(path, &mut prompter, cli.yes).await,
                Some(ConfigCommand::List { reveal }) => config_cmd::list(path, reveal),
                Some(ConfigCommand::Get { key, env, reveal }) => {
                    config_cmd::get(path, key, env, reveal)
                }
                Some(ConfigCommand::Set { env, args }) => {
                    config_cmd::set(path, args, env, cli.yes).await
                }
                Some(ConfigCommand::Unset { key, env }) => {
                    config_cmd::unset(path, key, env, cli.yes).await
                }
                Some(ConfigCommand::Edit) => config_cmd::edit(path, cli.yes).await,
            }
        }
        Command::Doctor => {
            init_logging("warn", false);
            doctor::run(&cli.config).await
        }
        Command::Core => {
            let config = load_config(&cli.config)?;
            init_logging(&log_filter(&config), false);
            let boot = boot::build(&config, boot::Options::default()).await?;
            boot.run_until_ctrl_c().await
        }
        Command::Stage => {
            let config = load_config(&cli.config)?;
            init_logging(&log_filter(&config), false);
            let mut stage: miyoria_stage::StageConfig = config.get("stage")?;
            let profile = boot::load_profile(&config)?;
            let avatar = profile.dir.join("avatar.toml");
            if avatar.exists() {
                stage.avatar = miyoria_stage::AvatarProfile::load(&avatar)?;
            }
            miyoria_stage::run_stage(stage).await
        }
        Command::Chat { name, with_discord } => {
            let config = load_config(&cli.config)?;
            // Keep the terminal readable: only warnings unless RUST_LOG says otherwise.
            init_logging("warn", true);
            let boot = boot::build(
                &config,
                boot::Options {
                    cli_chat_name: Some(name),
                    discord: with_discord,
                    api: false,
                },
            )
            .await?;
            println!("和 {} 聊天中(Ctrl+C 結束)。", boot.profile_display_name);
            boot.run_until_ctrl_c().await
        }
        Command::Status => {
            let config = load_config(&cli.config)?;
            remote::status(&remote::client(&config)?).await
        }
        Command::Module { command } => {
            let config = load_config(&cli.config)?;
            let (id, action) = match command {
                ModuleCommand::List => {
                    let client = remote::client(&config);
                    if let Ok(client) = &client
                        && client.health().await.is_ok()
                    {
                        return remote::modules(client).await;
                    }
                    println!("(core 沒有在執行,顯示設定檔內容)");
                    for (id, enabled) in boot::configured_modules(&config) {
                        println!("{} {id}", if enabled { "●" } else { "○" });
                    }
                    return Ok(());
                }
                ModuleCommand::Enable { id } => (id, "enable"),
                ModuleCommand::Disable { id } => (id, "disable"),
                ModuleCommand::Restart { id } => (id, "restart"),
            };
            remote::module_action(&remote::client(&config)?, &id, action).await
        }
        Command::Decisions { limit } => {
            let config = load_config(&cli.config)?;
            remote::decisions(&remote::client(&config)?, limit).await
        }
        Command::Events { topics } => {
            let config = load_config(&cli.config)?;
            remote::events(&remote::client(&config)?, &topics).await
        }
        Command::Persona { command } => {
            let config = load_config(&cli.config)?;
            let client = remote::client(&config)?;
            match command {
                PersonaCommand::Show => remote::persona_show(&client).await,
                PersonaCommand::Set { key, file } => {
                    let body = if file.as_os_str() == "-" {
                        std::io::read_to_string(std::io::stdin())?
                    } else {
                        std::fs::read_to_string(&file)?
                    };
                    remote::persona_set(&client, &key, body.trim()).await
                }
            }
        }
        Command::Ext { command } => ext(&cli.config, command).await,
        Command::Profile {
            command: ProfileCommand::Validate,
        } => {
            let config = load_config(&cli.config)?;
            let profile = boot::load_profile(&config)?;
            ui::ok(format!(
                "{}({}):{} 個人格段落、{} 個範例對話,聲音設定 {},模型設定 {}",
                profile.display_name(),
                profile.id,
                profile.sections.len(),
                profile.examples.len(),
                if profile.voice.is_some() {
                    "有"
                } else {
                    "無"
                },
                if profile.avatar.is_some() {
                    "有"
                } else {
                    "無"
                },
            ));
            Ok(())
        }
    }
}

async fn ext(config_path: &Path, command: ExtCommand) -> anyhow::Result<()> {
    use miyoria_ext_host::cli;

    let base = std::env::current_dir()?;
    let load = || load_config(config_path);
    match command {
        ExtCommand::New { name, dir } => {
            // Inside the monorepo link the local SDK; elsewhere use the published one.
            let sdk = if base.join("packages/sdk/package.json").exists() {
                "workspace:*"
            } else {
                "^0.1.0"
            };
            let opts = cli::NewOptions {
                sdk: sdk.to_owned(),
                id: None,
            };
            let path = cli::new_extension(&dir, &name, &opts)?;
            ui::ok(format!("已建立 {}", path.display()));
            Ok(())
        }
        ExtCommand::List => {
            for e in cli::list(&load()?, &base)? {
                let (id, version) = e
                    .manifest
                    .as_ref()
                    .map(|m| (m.id.clone(), m.version.clone()))
                    .unwrap_or_else(|| ("?".into(), "?".into()));
                let mark = if !e.problems.is_empty() {
                    "✗"
                } else if e.enabled && e.runs_on_core {
                    "●"
                } else {
                    "○"
                };
                println!("{mark} {id} {version}  {}", e.dir.display());
                for p in &e.problems {
                    println!("    {p}");
                }
            }
            Ok(())
        }
        ExtCommand::Install { source } => {
            let installed = cli::install(&load()?, &base, &source)?;
            ui::ok(format!(
                "已安裝 {} 到 {}",
                installed.id,
                installed.dir.display()
            ));
            for w in installed.warnings {
                ui::warn(w);
            }
            Ok(())
        }
        ExtCommand::Validate { dir } => {
            let v = cli::validate(&dir);
            for w in &v.warnings {
                ui::warn(w);
            }
            for e in &v.errors {
                ui::fail(e);
            }
            if v.is_ok() {
                ui::ok("manifest 正常");
                Ok(())
            } else {
                anyhow::bail!("{} 個錯誤", v.errors.len())
            }
        }
        ExtCommand::Dev => {
            let config = load()?;
            let mut raw = config.raw().clone();
            raw["modules"]["extensions"]["dev"] = serde_json::Value::Bool(true);
            let config = Config::from_value(raw);
            init_logging(&log_filter(&config), false);
            let boot = boot::build(&config, boot::Options::default()).await?;
            boot.run_until_ctrl_c().await
        }
    }
}

fn load_dotenv(config_path: &Path) {
    let dir = config_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let _ = dotenvy::from_path(dir.join(".env"));
}

fn log_filter(config: &Config) -> String {
    config
        .section("core.log")
        .and_then(|v| v.as_str())
        .unwrap_or("info")
        .to_owned()
}

fn init_logging(default: &str, stderr: bool) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default));
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    if stderr {
        builder.with_writer(std::io::stderr).init();
    } else {
        builder.init();
    }
}
