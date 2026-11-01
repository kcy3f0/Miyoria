// Slash command interactions: build the `Invocation`, run it, reply (deferring after 1.5 s).

import {
  type ArgValue,
  type CommandRegistry,
  CommandReply,
  type InvocationData,
  type ResolvedUser,
} from "@miyoria/commands";
import { errorMessage, getLogger, withTimeout } from "@miyoria/kernel";
import type { ContextKind } from "@miyoria/types";
import { MessageFlags } from "discord.js";
import {
  account,
  commandPath,
  contextKey,
  displayName,
  isGuildAdmin,
  type MemberLike,
  memberNick,
  memberRoleIds,
  type OptionLike,
  type ResolvedLike,
  resolvedUsers,
  type UserLike,
} from "./mapping.js";
import { MAX_MESSAGE_LEN, splitMessage } from "./split.js";

const log = getLogger("discord.interaction");

/** Discord wants an interaction response within 3 s; defer after this. */
export const DEFER_AFTER_MS = 1_500;

/** Shown when a command handler throws. */
export const HANDLER_FAILED_TEXT = "嗚……執行的時候出錯了。才不是我的問題,去看 log 啦。";

/** Mentions in command replies never ping anyone. */
const NO_MENTIONS = { parse: [] as never[] };

export interface ReplyOptions {
  content: string;
  flags?: MessageFlags.Ephemeral;
  allowedMentions: typeof NO_MENTIONS;
}

/** The parts of a `ChatInputCommandInteraction` that command handling uses. */
export interface CommandInteractionLike {
  commandName: string;
  user: UserLike;
  guildId: string | null;
  channelId: string;
  /** The channel's type, when the channel is cached. */
  channel?: { type: number } | null;
  member?: MemberLike | null;
  options: { data: readonly OptionLike[]; resolved?: ResolvedLike | null };
  reply(options: ReplyOptions): Promise<unknown>;
  deferReply(options: { flags?: MessageFlags.Ephemeral }): Promise<unknown>;
  editReply(options: Omit<ReplyOptions, "flags">): Promise<unknown>;
  followUp(options: ReplyOptions): Promise<unknown>;
  deleteReply(): Promise<unknown>;
}

/** Builds the invocation of an interaction. `kind` is the channel's context kind. */
export function invocationFromInteraction(
  interaction: CommandInteractionLike,
  kind: ContextKind,
): InvocationData {
  const { path, args } = commandPath(interaction.commandName, interaction.options.data);
  const member = interaction.member ?? null;
  const argRecord: Record<string, ArgValue> = {};
  for (const [name, value] of args) argRecord[name] = value;
  const resolved: Record<string, ResolvedUser> = {};
  for (const [id, user] of resolvedUsers(interaction.options.resolved)) resolved[id] = user;
  return {
    path,
    args: argRecord,
    invoker: account(interaction.user.id),
    invoker_display_name: displayName(interaction.user, memberNick(member)),
    context: contextKey(interaction.guildId, interaction.channelId, kind),
    invoker_is_guild_admin: isGuildAdmin(member),
    platform_roles: memberRoleIds(member),
    resolved_users: resolved,
  };
}

export type CommandDispatcher = Pick<CommandRegistry, "dispatch" | "get">;

export interface HandleOptions {
  /** Defer the interaction when the handler takes longer than this. */
  deferAfterMs?: number;
}

/**
 * Runs the command of `interaction` and replies. Fast commands are answered directly; slow ones
 * are deferred after `deferAfterMs` (with the spec's default visibility) and answered with an
 * edit once done. Never throws.
 */
export async function handleCommandInteraction(
  registry: CommandDispatcher,
  interaction: CommandInteractionLike,
  kind: ContextKind,
  options: HandleOptions = {},
): Promise<void> {
  const invocation = invocationFromInteraction(interaction, kind);
  const name = invocation.path.join(" ");
  const defaultEphemeral = registry.get(invocation.path)?.ephemeral ?? true;
  log.debug({ command: name, user: interaction.user.id }, "slash command");

  const settled: Promise<CommandReply> = registry.dispatch(invocation).then(
    (reply) => reply,
    (error: unknown) => {
      log.warn({ command: name, error: errorMessage(error) }, "command handler failed");
      return CommandReply.ephemeral(HANDLER_FAILED_TEXT);
    },
  );
  try {
    const quick = await withTimeout(settled, options.deferAfterMs ?? DEFER_AFTER_MS);
    if (quick !== undefined) {
      await respond(interaction, quick, null);
      return;
    }
    try {
      await interaction.deferReply({
        flags: defaultEphemeral ? MessageFlags.Ephemeral : undefined,
      });
    } catch (error) {
      log.warn({ command: name, error: errorMessage(error) }, "cannot defer interaction");
    }
    await respond(interaction, await settled, defaultEphemeral);
  } catch (error) {
    log.warn({ command: name, error: errorMessage(error) }, "cannot respond to interaction");
  }
}

/**
 * Sends `reply`, split into chunks. `deferred` is the visibility the interaction was deferred
 * with, if it was.
 */
export async function respond(
  interaction: CommandInteractionLike,
  reply: CommandReply,
  deferred: boolean | null,
): Promise<void> {
  const ephemeral = reply.ephemeral;
  const [first = "……", ...rest] = splitMessage(reply.text, MAX_MESSAGE_LEN);
  const message = (content: string): ReplyOptions => ({
    content,
    flags: ephemeral ? MessageFlags.Ephemeral : undefined,
    allowedMentions: NO_MENTIONS,
  });
  if (deferred === null) {
    await interaction.reply(message(first));
  } else if (deferred === ephemeral) {
    await interaction.editReply({ content: first, allowedMentions: NO_MENTIONS });
  } else {
    // Visibility of a deferred response cannot change: replace it.
    await interaction.followUp(message(first));
    await interaction.deleteReply();
  }
  for (const chunk of rest) await interaction.followUp(message(chunk));
}
