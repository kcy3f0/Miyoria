//! Maps [`CommandSpec`]s to Discord application commands.
//!
//! Path depth 1 is a top-level command, depth 2 a subcommand, depth 3 a
//! subcommand inside a subcommand group.

use miyoria_commands::{ArgKind, ArgSpec, CommandSpec};
use serenity::all::{CommandOptionType, CreateCommand, CreateCommandOption};
use tracing::warn;

const MAX_DESCRIPTION: usize = 100;
/// Discord allows 25 options, subcommands and choices per level.
const MAX_ITEMS: usize = 25;
const MAX_TOP_LEVEL: usize = 100;

/// Platform-independent shape of one slash command level.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlashNode {
    pub name: String,
    pub description: String,
    pub kind: SlashKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SlashKind {
    Leaf(Vec<ArgSpec>),
    Parent(Vec<SlashNode>),
}

/// Builds the command tree. `group_description` supplies descriptions of
/// parent levels; missing ones fall back to the path.
pub fn build_tree(
    specs: &[CommandSpec],
    group_description: impl Fn(&[String]) -> Option<String>,
) -> Vec<SlashNode> {
    let mut roots: Vec<SlashNode> = Vec::new();
    for spec in specs {
        if spec.path.is_empty() || spec.path.len() > 3 {
            warn!(command = %spec.name(), "unsupported command depth, skipped");
            continue;
        }
        insert(&mut roots, spec, 0, &group_description);
    }
    roots
}

fn insert(
    level: &mut Vec<SlashNode>,
    spec: &CommandSpec,
    depth: usize,
    group_description: &impl Fn(&[String]) -> Option<String>,
) {
    let name = &spec.path[depth];
    let is_leaf = depth + 1 == spec.path.len();
    let existing = level.iter().position(|n| &n.name == name);
    if is_leaf {
        if existing.is_some() {
            warn!(command = %spec.name(), "conflicts with another command, skipped");
            return;
        }
        level.push(SlashNode {
            name: name.clone(),
            description: spec.description.clone(),
            kind: SlashKind::Leaf(spec.args.clone()),
        });
        return;
    }
    let idx = match existing {
        Some(idx) => idx,
        None => {
            let prefix = &spec.path[..=depth];
            level.push(SlashNode {
                name: name.clone(),
                description: group_description(prefix).unwrap_or_else(|| prefix.join(" ")),
                kind: SlashKind::Parent(Vec::new()),
            });
            level.len() - 1
        }
    };
    match &mut level[idx].kind {
        SlashKind::Parent(children) => insert(children, spec, depth + 1, group_description),
        SlashKind::Leaf(_) => {
            warn!(command = %spec.name(), "conflicts with another command, skipped");
        }
    }
}

/// Converts the tree into serenity builders for a bulk overwrite.
pub fn to_create_commands(tree: &[SlashNode]) -> Vec<CreateCommand> {
    if tree.len() > MAX_TOP_LEVEL {
        warn!(
            count = tree.len(),
            "too many top-level commands, extra ones dropped"
        );
    }
    tree.iter()
        .take(MAX_TOP_LEVEL)
        .map(|node| {
            let cmd = CreateCommand::new(&node.name).description(truncate(&node.description));
            let options = match &node.kind {
                SlashKind::Leaf(args) => arg_options(args),
                SlashKind::Parent(children) => limited(children, &node.name)
                    .iter()
                    .map(sub_option)
                    .collect(),
            };
            cmd.set_options(options)
        })
        .collect()
}

fn sub_option(node: &SlashNode) -> CreateCommandOption {
    let description = truncate(&node.description);
    match &node.kind {
        SlashKind::Leaf(args) => {
            CreateCommandOption::new(CommandOptionType::SubCommand, &node.name, description)
                .set_sub_options(arg_options(args))
        }
        SlashKind::Parent(children) => {
            CreateCommandOption::new(CommandOptionType::SubCommandGroup, &node.name, description)
                .set_sub_options(limited(children, &node.name).iter().map(sub_option))
        }
    }
}

/// Required options first (Discord rejects required after optional).
fn arg_options(args: &[ArgSpec]) -> Vec<CreateCommandOption> {
    let mut sorted: Vec<&ArgSpec> = args.iter().collect();
    sorted.sort_by_key(|a| !a.required);
    sorted
        .into_iter()
        .take(MAX_ITEMS)
        .map(|arg| {
            let kind = match arg.kind {
                ArgKind::String | ArgKind::Choice(_) => CommandOptionType::String,
                ArgKind::Integer => CommandOptionType::Integer,
                ArgKind::Boolean => CommandOptionType::Boolean,
            };
            let description = if arg.description.trim().is_empty() {
                arg.name.clone()
            } else {
                truncate(&arg.description)
            };
            let mut opt =
                CreateCommandOption::new(kind, &arg.name, description).required(arg.required);
            if let ArgKind::Choice(choices) = &arg.kind {
                for c in choices.iter().take(MAX_ITEMS) {
                    opt = opt.add_string_choice(c, c);
                }
            }
            opt
        })
        .collect()
}

fn limited<'a>(children: &'a [SlashNode], parent: &str) -> &'a [SlashNode] {
    if children.len() > MAX_ITEMS {
        warn!(%parent, "more than {MAX_ITEMS} subcommands, extra ones dropped");
        &children[..MAX_ITEMS]
    } else {
        children
    }
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= MAX_DESCRIPTION {
        s.to_owned()
    } else {
        let mut out: String = s.chars().take(MAX_DESCRIPTION - 1).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn specs() -> Vec<CommandSpec> {
        vec![
            CommandSpec::new("ping", "Ping"),
            CommandSpec::new("admin module list", "List modules"),
            CommandSpec::new("admin module enable", "Enable").arg(ArgSpec::new(
                "id",
                "Module id",
                ArgKind::String,
            )),
            CommandSpec::new("admin block", "Block someone")
                .arg(ArgSpec::new("reason", "Why", ArgKind::String).optional())
                .arg(ArgSpec::new(
                    "mode",
                    "Mode",
                    ArgKind::Choice(vec!["soft".into(), "hard".into()]),
                )),
        ]
    }

    #[test]
    fn builds_nested_tree() {
        let tree = build_tree(&specs(), |p| (p == ["admin"]).then(|| "管理".to_owned()));
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].name, "ping");
        let SlashKind::Parent(admin) = &tree[1].kind else {
            panic!("admin should be a group");
        };
        assert_eq!(tree[1].description, "管理");
        assert_eq!(admin[0].name, "module");
        assert_eq!(admin[0].description, "admin module");
        assert!(matches!(&admin[0].kind, SlashKind::Parent(c) if c.len() == 2));
        assert!(matches!(&admin[1].kind, SlashKind::Leaf(a) if a.len() == 2));
    }

    #[test]
    fn skips_conflicts() {
        let mut s = specs();
        s.push(CommandSpec::new("ping sub", "conflicts with leaf ping"));
        s.push(CommandSpec::new("admin", "conflicts with group admin"));
        let tree = build_tree(&s, |_| None);
        assert_eq!(tree.len(), 2);
        assert!(matches!(tree[0].kind, SlashKind::Leaf(_)));
    }

    #[test]
    fn serializes_to_discord_shape() {
        let cmds = to_create_commands(&build_tree(&specs(), |_| None));
        let json = serde_json::to_value(&cmds).unwrap();
        assert_eq!(json[0]["name"], "ping");
        assert_eq!(json[0]["options"], json!([]));

        let admin = &json[1];
        assert_eq!(admin["name"], "admin");
        let module = &admin["options"][0];
        assert_eq!(module["type"], 2); // SUB_COMMAND_GROUP
        assert_eq!(module["options"][1]["name"], "enable");
        assert_eq!(module["options"][1]["type"], 1); // SUB_COMMAND
        assert_eq!(module["options"][1]["options"][0]["name"], "id");
        assert_eq!(module["options"][1]["options"][0]["required"], true);

        let block = &admin["options"][1];
        assert_eq!(block["type"], 1);
        // Required `mode` is moved before optional `reason`.
        assert_eq!(block["options"][0]["name"], "mode");
        assert_eq!(block["options"][0]["choices"][1]["value"], "hard");
        assert_eq!(block["options"][1]["name"], "reason");
        assert_eq!(block["options"][1]["required"], false);
    }

    #[test]
    fn truncates_long_descriptions() {
        let long = "說".repeat(150);
        assert_eq!(truncate(&long).chars().count(), MAX_DESCRIPTION);
        assert_eq!(truncate("short"), "short");
    }
}
