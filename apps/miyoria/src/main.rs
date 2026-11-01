mod boot;
mod cli_platform;
mod doctor;
mod init;
mod remote;

use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use miyoria_kernel::Config;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "miyoria", version, about = "Miyoria — AI waifu framework")]
struct Cli {
    /// Path to miyoria.toml
    #[arg(long, short, global = true, default_value = "miyoria.toml")]
    config: PathBuf,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Interactive setup: API keys, Discord token, database
    Init,
    /// Check config, profile, LLM, Discord and database connectivity
    Doctor,
    /// Run the core node (Discord bot, agent, ...)
    Core,
    /// Chat with her in the terminal (no Discord needed)
    Chat {
        /// Your display name in the conversation
        #[arg(long, default_value = "你")]
        name: String,
        /// Also connect the Discord bot while chatting
        #[arg(long)]
        with_discord: bool,
    },
    /// Status of the running core: modules and LLM usage
    Status,
    /// Manage modules (subsystems) of the running core
    Module {
        #[command(subcommand)]
        command: ModuleCommand,
    },
    /// Recent attention decisions (why she replied or stayed quiet)
    Decisions {
        #[arg(long, short, default_value_t = 20)]
        limit: usize,
    },
    /// Follow live events of the running core, e.g. `miyoria events 'agent.*'`
    Events { topics: Vec<String> },
    /// Persona sections of the running core
    Persona {
        #[command(subcommand)]
        command: PersonaCommand,
    },
    /// Profile tools (offline)
    Profile {
        #[command(subcommand)]
        command: ProfileCommand,
    },
}

#[derive(Subcommand)]
enum ModuleCommand {
    /// List modules (falls back to the config when the core is not running)
    List,
    Enable {
        id: String,
    },
    Disable {
        id: String,
    },
    Restart {
        id: String,
    },
}

#[derive(Subcommand)]
enum PersonaCommand {
    Show,
    /// Replace a section with the contents of a file (`-` for stdin)
    Set {
        key: String,
        file: PathBuf,
    },
}

#[derive(Subcommand)]
enum ProfileCommand {
    /// Load and validate the active profile
    Validate,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    load_dotenv(&cli.config);

    match cli.command {
        Command::Init => init::run(&cli.config),
        Command::Doctor => {
            init_logging("warn", false);
            doctor::run(&cli.config).await
        }
        Command::Core => {
            let config = Config::load(&cli.config)?;
            init_logging(&log_filter(&config), false);
            let boot = boot::build(&config, boot::Options::default()).await?;
            boot.run_until_ctrl_c().await
        }
        Command::Chat { name, with_discord } => {
            let config = Config::load(&cli.config)?;
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
            let config = Config::load(&cli.config)?;
            remote::status(&remote::client(&config)?).await
        }
        Command::Module { command } => {
            let config = Config::load(&cli.config)?;
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
            let config = Config::load(&cli.config)?;
            remote::decisions(&remote::client(&config)?, limit).await
        }
        Command::Events { topics } => {
            let config = Config::load(&cli.config)?;
            remote::events(&remote::client(&config)?, &topics).await
        }
        Command::Persona { command } => {
            let config = Config::load(&cli.config)?;
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
        Command::Profile {
            command: ProfileCommand::Validate,
        } => {
            let config = Config::load(&cli.config)?;
            let profile = boot::load_profile(&config)?;
            println!(
                "✓ {}({}):{} 個人格段落、{} 個範例對話,聲音設定 {},模型設定 {}",
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
            );
            Ok(())
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
