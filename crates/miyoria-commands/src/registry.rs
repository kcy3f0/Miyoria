use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::RwLock;
use tokio::sync::watch;
use tracing::warn;

use crate::perms::{Permissions, Role};
use crate::spec::{ArgKind, ArgValue, CommandReply, CommandSpec, Invocation};

/// Deepest supported command path (Discord: group / subcommand group / subcommand).
pub const MAX_PATH_DEPTH: usize = 3;
const MAX_NAME_LEN: usize = 32;

pub type HandlerFuture = BoxFuture<'static, anyhow::Result<CommandReply>>;
type Handler = Arc<dyn Fn(Invocation) -> HandlerFuture + Send + Sync>;

struct Entry {
    spec: CommandSpec,
    handler: Handler,
}

/// Every registered command. Provided as the service `Arc<CommandRegistry>` by
/// the `commands` module; other modules may register commands at any time and
/// platforms watch [`subscribe`](Self::subscribe) to re-sync.
pub struct CommandRegistry {
    perms: Permissions,
    entries: RwLock<BTreeMap<Vec<String>, Entry>>,
    groups: RwLock<BTreeMap<Vec<String>, String>>,
    version: watch::Sender<u64>,
}

impl CommandRegistry {
    pub fn new(perms: Permissions) -> Self {
        Self {
            perms,
            entries: RwLock::new(BTreeMap::new()),
            groups: RwLock::new(BTreeMap::new()),
            version: watch::Sender::new(0),
        }
    }

    pub fn permissions(&self) -> &Permissions {
        &self.perms
    }

    /// Registers (or replaces) the command at `spec.path`.
    ///
    /// Fails if the spec is malformed or if its path is a prefix of another
    /// command's path (or the other way round), which hierarchical platforms
    /// cannot represent.
    pub fn register<F, Fut>(&self, spec: CommandSpec, handler: F) -> anyhow::Result<()>
    where
        F: Fn(Invocation) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = anyhow::Result<CommandReply>> + Send + 'static,
    {
        validate_spec(&spec)?;
        let handler: Handler = Arc::new(move |inv| handler(inv).boxed());
        {
            let mut entries = self.entries.write();
            if let Some(other) = entries.keys().find(|p| {
                **p != spec.path && (p.starts_with(&spec.path) || spec.path.starts_with(p))
            }) {
                anyhow::bail!(
                    "command `{}` conflicts with `{}`",
                    spec.name(),
                    other.join(" ")
                );
            }
            entries.insert(spec.path.clone(), Entry { spec, handler });
        }
        self.bump();
        Ok(())
    }

    /// Removes the command at the space separated `path`.
    pub fn unregister(&self, path: &str) -> bool {
        let path = split_path(path);
        let removed = self.entries.write().remove(&path).is_some();
        if removed {
            self.bump();
        }
        removed
    }

    /// Sets the description of a command group such as `"admin"` or
    /// `"admin module"` (platforms need one for each parent level).
    pub fn set_group_description(&self, path: &str, description: impl Into<String>) {
        self.groups
            .write()
            .insert(split_path(path), description.into());
        self.bump();
    }

    pub fn group_description(&self, path: &[String]) -> Option<String> {
        self.groups.read().get(path).cloned()
    }

    /// All registered commands, ordered by path.
    pub fn specs(&self) -> Vec<CommandSpec> {
        self.entries
            .read()
            .values()
            .map(|e| e.spec.clone())
            .collect()
    }

    pub fn get(&self, path: &[String]) -> Option<CommandSpec> {
        self.entries.read().get(path).map(|e| e.spec.clone())
    }

    /// Increases on every registration change.
    pub fn version(&self) -> u64 {
        *self.version.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.version.subscribe()
    }

    /// Checks permissions and arguments, then runs the handler.
    ///
    /// Unknown commands, permission denials and invalid arguments become
    /// ephemeral replies; only handler failures are returned as errors.
    pub async fn dispatch(&self, mut invocation: Invocation) -> anyhow::Result<CommandReply> {
        let found = self
            .entries
            .read()
            .get(&invocation.path)
            .map(|e| (e.spec.clone(), e.handler.clone()));
        let Some((spec, handler)) = found else {
            return Ok(CommandReply::ephemeral(format!(
                "沒有「{}」這個指令啦,你是不是打錯了?",
                invocation.path.join(" ")
            )));
        };
        if !self.perms.allows(&invocation, &spec.permission) {
            return Ok(CommandReply::ephemeral(denial(Role::required_for(
                &spec.permission,
            ))));
        }
        match normalize_args(&spec, std::mem::take(&mut invocation.args)) {
            Ok(args) => invocation.args = args,
            Err(problem) => {
                return Ok(CommandReply::ephemeral(format!(
                    "{problem}……參數要好好給我啦。"
                )));
            }
        }
        handler(invocation).await
    }

    fn bump(&self) {
        self.version.send_modify(|v| *v += 1);
    }
}

fn denial(required: Role) -> String {
    match required {
        Role::Owner => "這個只有我的主人能用,你、你又不是!".to_owned(),
        _ => "你沒有權限做這個啦。".to_owned(),
    }
}

fn split_path(path: &str) -> Vec<String> {
    path.split_whitespace().map(str::to_owned).collect()
}

fn valid_name(name: &str) -> bool {
    let len = name.chars().count();
    (1..=MAX_NAME_LEN).contains(&len)
        && name
            .chars()
            .all(|c| (c.is_alphanumeric() && !c.is_uppercase()) || c == '-' || c == '_')
}

fn validate_spec(spec: &CommandSpec) -> anyhow::Result<()> {
    let name = spec.name();
    if spec.path.is_empty() || spec.path.len() > MAX_PATH_DEPTH {
        anyhow::bail!("command `{name}`: path must have 1 to {MAX_PATH_DEPTH} words");
    }
    if let Some(bad) = spec.path.iter().find(|p| !valid_name(p)) {
        anyhow::bail!("command `{name}`: invalid name `{bad}`");
    }
    if spec.description.trim().is_empty() {
        anyhow::bail!("command `{name}`: description is empty");
    }
    let mut seen = HashSet::new();
    for arg in &spec.args {
        if !valid_name(&arg.name) {
            anyhow::bail!("command `{name}`: invalid argument name `{}`", arg.name);
        }
        if !seen.insert(arg.name.as_str()) {
            anyhow::bail!("command `{name}`: duplicate argument `{}`", arg.name);
        }
        if matches!(&arg.kind, ArgKind::Choice(choices) if choices.is_empty()) {
            anyhow::bail!("command `{name}`: argument `{}` has no choices", arg.name);
        }
    }
    Ok(())
}

/// Validates `args` against the spec and coerces string values (from text
/// platforms) to the declared kinds. Errors are user-facing.
pub fn normalize_args(
    spec: &CommandSpec,
    mut args: BTreeMap<String, ArgValue>,
) -> Result<BTreeMap<String, ArgValue>, String> {
    if let Some(unknown) = args
        .keys()
        .find(|k| !spec.args.iter().any(|a| &a.name == *k))
    {
        return Err(format!("「{unknown}」不是這個指令的參數"));
    }
    let mut out = BTreeMap::new();
    for arg in &spec.args {
        let Some(value) = args.remove(&arg.name) else {
            if arg.required {
                return Err(format!("少了「{}」", arg.name));
            }
            continue;
        };
        let value = match (&arg.kind, value) {
            (ArgKind::String, ArgValue::String(s)) => ArgValue::String(s),
            (ArgKind::Integer, ArgValue::Integer(i)) => ArgValue::Integer(i),
            (ArgKind::Integer, ArgValue::String(s)) => match s.trim().parse() {
                Ok(i) => ArgValue::Integer(i),
                Err(_) => return Err(format!("「{}」要是整數", arg.name)),
            },
            (ArgKind::Boolean, ArgValue::Boolean(b)) => ArgValue::Boolean(b),
            (ArgKind::Boolean, ArgValue::String(s)) => match s.trim().to_lowercase().as_str() {
                "true" | "yes" | "on" | "1" => ArgValue::Boolean(true),
                "false" | "no" | "off" | "0" => ArgValue::Boolean(false),
                _ => return Err(format!("「{}」要是 true 或 false", arg.name)),
            },
            (ArgKind::Choice(choices), ArgValue::String(s)) => {
                if choices.contains(&s) {
                    ArgValue::String(s)
                } else {
                    return Err(format!(
                        "「{}」只能是 {} 其中之一",
                        arg.name,
                        choices.join(" / ")
                    ));
                }
            }
            (kind, value) => {
                warn!(arg = %arg.name, ?kind, ?value, "argument has the wrong type");
                return Err(format!("「{}」的型別不對", arg.name));
            }
        };
        out.insert(arg.name.clone(), value);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use miyoria_types::{ContextKey, ContextKind, PlatformId};

    use super::*;
    use crate::perms::parse_account;
    use crate::spec::ArgSpec;

    fn registry() -> CommandRegistry {
        CommandRegistry::new(Permissions::from_strings(&["discord:1"]).unwrap())
    }

    fn inv(path: &str, invoker: &str, args: &[(&str, ArgValue)]) -> Invocation {
        Invocation {
            path: split_path(path),
            args: args
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
            invoker: parse_account(&format!("discord:{invoker}")).unwrap(),
            invoker_display_name: "someone".into(),
            context: ContextKey {
                platform: PlatformId::new("discord"),
                scope: None,
                channel: "9".into(),
                kind: ContextKind::Dm,
            },
            invoker_is_guild_admin: false,
        }
    }

    fn echo_spec() -> CommandSpec {
        CommandSpec::new("echo", "Repeats text")
            .arg(ArgSpec::new("text", "What to say", ArgKind::String))
            .arg(ArgSpec::new("times", "How often", ArgKind::Integer).optional())
            .arg(ArgSpec::new("loud", "Shout", ArgKind::Boolean).optional())
            .arg(
                ArgSpec::new(
                    "mood",
                    "Mood",
                    ArgKind::Choice(vec!["happy".into(), "grumpy".into()]),
                )
                .optional(),
            )
    }

    fn register_echo(reg: &CommandRegistry) {
        reg.register(echo_spec(), |inv: Invocation| async move {
            let text = inv.str("text").unwrap_or_default().to_owned();
            let times = inv.int("times").unwrap_or(1);
            let mut out = vec![text; usize::try_from(times).unwrap_or(1)].join(" ");
            if inv.bool("loud") == Some(true) {
                out = out.to_uppercase();
            }
            Ok(CommandReply::public(out))
        })
        .unwrap();
    }

    #[tokio::test]
    async fn dispatches_with_typed_args() {
        let reg = registry();
        register_echo(&reg);
        let reply = reg
            .dispatch(inv(
                "echo",
                "5",
                &[
                    ("text", ArgValue::String("hi".into())),
                    ("times", ArgValue::String("2".into())),
                    ("loud", ArgValue::Boolean(true)),
                ],
            ))
            .await
            .unwrap();
        assert_eq!(reply, CommandReply::public("HI HI"));
    }

    #[tokio::test]
    async fn rejects_bad_args() {
        let reg = registry();
        register_echo(&reg);
        let cases: Vec<Vec<(&str, ArgValue)>> = vec![
            vec![],
            vec![
                ("text", ArgValue::String("a".into())),
                ("times", ArgValue::String("x".into())),
            ],
            vec![("text", ArgValue::Integer(3))],
            vec![
                ("text", ArgValue::String("a".into())),
                ("mood", ArgValue::String("sad".into())),
            ],
            vec![
                ("text", ArgValue::String("a".into())),
                ("nope", ArgValue::Boolean(true)),
            ],
        ];
        for args in cases {
            let reply = reg.dispatch(inv("echo", "5", &args)).await.unwrap();
            assert!(reply.ephemeral, "{args:?}");
            assert!(reply.text.contains("參數"), "{args:?}: {}", reply.text);
        }
    }

    #[tokio::test]
    async fn unknown_command_and_denial() {
        let reg = registry();
        reg.register(
            CommandSpec::new("admin secret", "Secret").permission("admin.secret"),
            |_| async { Ok(CommandReply::public("ok")) },
        )
        .unwrap();
        let unknown = reg.dispatch(inv("nope", "5", &[])).await.unwrap();
        assert!(unknown.ephemeral && unknown.text.contains("nope"));

        let denied = reg.dispatch(inv("admin secret", "5", &[])).await.unwrap();
        assert_eq!(denied, CommandReply::ephemeral("你沒有權限做這個啦。"));

        let mut as_admin = inv("admin secret", "5", &[]);
        as_admin.invoker_is_guild_admin = true;
        assert_eq!(reg.dispatch(as_admin).await.unwrap().text, "ok");
        let as_owner = inv("admin secret", "1", &[]);
        assert_eq!(reg.dispatch(as_owner).await.unwrap().text, "ok");
    }

    #[tokio::test]
    async fn handler_errors_propagate() {
        let reg = registry();
        reg.register(CommandSpec::new("fail", "Fails"), |_| async {
            anyhow::bail!("broken")
        })
        .unwrap();
        assert!(reg.dispatch(inv("fail", "5", &[])).await.is_err());
    }

    #[test]
    fn validates_specs_and_conflicts() {
        let reg = registry();
        let ok = |_: Invocation| async { Ok(CommandReply::public("")) };
        assert!(reg.register(CommandSpec::new("Bad", "x"), ok).is_err());
        assert!(reg.register(CommandSpec::new("a b c d", "x"), ok).is_err());
        assert!(reg.register(CommandSpec::new("empty", " "), ok).is_err());
        assert!(
            reg.register(
                CommandSpec::new("dup", "x")
                    .arg(ArgSpec::new("a", "a", ArgKind::String))
                    .arg(ArgSpec::new("a", "a", ArgKind::String)),
                ok
            )
            .is_err()
        );
        reg.register(CommandSpec::new("admin module list", "x"), ok)
            .unwrap();
        assert!(
            reg.register(CommandSpec::new("admin module", "x"), ok)
                .is_err()
        );
        assert!(reg.register(CommandSpec::new("admin", "x"), ok).is_err());
        reg.register(CommandSpec::new("admin block", "x"), ok)
            .unwrap();
        // Replacing the same path is fine.
        reg.register(CommandSpec::new("admin block", "y"), ok)
            .unwrap();
        assert_eq!(reg.specs().len(), 2);
    }

    #[tokio::test]
    async fn version_changes_are_observable() {
        let reg = registry();
        let mut rx = reg.subscribe();
        let before = reg.version();
        register_echo(&reg);
        rx.changed().await.unwrap();
        assert!(*rx.borrow_and_update() > before);
        assert!(reg.unregister("echo"));
        assert!(!reg.unregister("echo"));
        rx.changed().await.unwrap();
        assert!(reg.specs().is_empty());
    }
}
