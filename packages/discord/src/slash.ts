// Maps `CommandSpec`s to Discord application commands.
//
// Path depth 1 is a top-level command, depth 2 a subcommand, depth 3 a subcommand inside a
// subcommand group.

import type { ArgSpec, CommandSpec } from "@miyoria/commands";
import { getLogger } from "@miyoria/kernel";
import { ApplicationCommandOptionType } from "discord.js";

const log = getLogger("discord.slash");

const MAX_DESCRIPTION = 100;
/** Discord allows 25 options, subcommands and choices per level. */
const MAX_ITEMS = 25;
const MAX_TOP_LEVEL = 100;
const MAX_DEPTH = 3;

/** Platform-independent shape of one slash command level. */
export interface SlashNode {
  name: string;
  description: string;
  kind: SlashKind;
}

export type SlashKind =
  | { type: "leaf"; args: ArgSpec[] }
  | { type: "parent"; children: SlashNode[] };

/** JSON body of one application command (what the REST API accepts). */
export interface SlashCommandJson {
  name: string;
  description: string;
  options: SlashOptionJson[];
}

export interface SlashOptionJson {
  type: ApplicationCommandOptionType;
  name: string;
  description: string;
  required?: boolean;
  choices?: { name: string; value: string }[];
  options?: SlashOptionJson[];
}

/**
 * Builds the command tree. `groupDescription` supplies descriptions of parent levels; missing
 * ones fall back to the path.
 */
export function buildTree(
  specs: readonly CommandSpec[],
  groupDescription: (path: readonly string[]) => string | null | undefined,
): SlashNode[] {
  const roots: SlashNode[] = [];
  for (const spec of specs) {
    if (spec.path.length === 0 || spec.path.length > MAX_DEPTH) {
      log.warn({ command: spec.path.join(" ") }, "unsupported command depth, skipped");
      continue;
    }
    insert(roots, spec, 0, groupDescription);
  }
  return roots;
}

function insert(
  level: SlashNode[],
  spec: CommandSpec,
  depth: number,
  groupDescription: (path: readonly string[]) => string | null | undefined,
): void {
  const name = spec.path[depth] as string;
  const isLeaf = depth + 1 === spec.path.length;
  const existing = level.find((n) => n.name === name);
  const conflict = () =>
    log.warn({ command: spec.path.join(" ") }, "conflicts with another command, skipped");
  if (isLeaf) {
    if (existing) {
      conflict();
      return;
    }
    level.push({
      name,
      description: spec.description,
      kind: { type: "leaf", args: [...spec.args] },
    });
    return;
  }
  let node = existing;
  if (!node) {
    const prefix = spec.path.slice(0, depth + 1);
    node = {
      name,
      description: groupDescription(prefix) ?? prefix.join(" "),
      kind: { type: "parent", children: [] },
    };
    level.push(node);
  }
  if (node.kind.type === "parent") insert(node.kind.children, spec, depth + 1, groupDescription);
  else conflict();
}

/** Converts the tree into the JSON bodies of a bulk overwrite. */
export function toCreateCommands(tree: readonly SlashNode[]): SlashCommandJson[] {
  if (tree.length > MAX_TOP_LEVEL) {
    log.warn({ count: tree.length }, "too many top-level commands, extra ones dropped");
  }
  return tree.slice(0, MAX_TOP_LEVEL).map((node) => ({
    name: node.name,
    description: truncate(node.description),
    options:
      node.kind.type === "leaf"
        ? argOptions(node.kind.args)
        : limited(node.kind.children, node.name).map(subOption),
  }));
}

function subOption(node: SlashNode): SlashOptionJson {
  const description = truncate(node.description);
  if (node.kind.type === "leaf") {
    return {
      type: ApplicationCommandOptionType.Subcommand,
      name: node.name,
      description,
      options: argOptions(node.kind.args),
    };
  }
  return {
    type: ApplicationCommandOptionType.SubcommandGroup,
    name: node.name,
    description,
    options: limited(node.kind.children, node.name).map(subOption),
  };
}

function optionType(kind: ArgSpec["kind"]): ApplicationCommandOptionType {
  switch (kind.type) {
    case "string":
    case "choice":
      return ApplicationCommandOptionType.String;
    case "integer":
      return ApplicationCommandOptionType.Integer;
    case "boolean":
      return ApplicationCommandOptionType.Boolean;
    case "user":
      return ApplicationCommandOptionType.User;
    case "role":
      return ApplicationCommandOptionType.Role;
  }
}

/** Required options first (Discord rejects required after optional). */
function argOptions(args: readonly ArgSpec[]): SlashOptionJson[] {
  // Array.prototype.sort is stable: relative order within each group is kept.
  const sorted = [...args].sort((a, b) => Number(!a.required) - Number(!b.required));
  return sorted.slice(0, MAX_ITEMS).map((arg) => {
    const option: SlashOptionJson = {
      type: optionType(arg.kind),
      name: arg.name,
      description: arg.description.trim() === "" ? arg.name : truncate(arg.description),
      required: arg.required,
    };
    if (arg.kind.type === "choice") {
      option.choices = arg.kind.choices.slice(0, MAX_ITEMS).map((c) => ({ name: c, value: c }));
    }
    return option;
  });
}

function limited(children: readonly SlashNode[], parent: string): readonly SlashNode[] {
  if (children.length > MAX_ITEMS) {
    log.warn({ parent }, `more than ${MAX_ITEMS} subcommands, extra ones dropped`);
    return children.slice(0, MAX_ITEMS);
  }
  return children;
}

/** At most `MAX_DESCRIPTION` characters (code points); longer text ends in `…`. */
export function truncate(s: string): string {
  const chars = Array.from(s);
  if (chars.length <= MAX_DESCRIPTION) return s;
  return `${chars.slice(0, MAX_DESCRIPTION - 1).join("")}…`;
}
