// Pure conversions between discord.js models and Miyoria types. The inputs are structural
// subsets of the discord.js classes (and of the raw API shapes), so tests can build plain
// objects and no live Discord is needed.

import type { ResolvedUser } from "@miyoria/commands";
import {
  type AccountRef,
  type Attachment,
  type ContextKey,
  type ContextKind,
  type IncomingMessage,
  type PlatformId,
  toTimestamp,
} from "@miyoria/types";
import { ApplicationCommandOptionType, ChannelType } from "discord.js";

export const PLATFORM: PlatformId = "discord";

/** Discord permission bits that make a member a guild admin. */
export const ADMINISTRATOR = 1n << 3n;
export const MANAGE_GUILD = 1n << 5n;

export function platform(): PlatformId {
  return PLATFORM;
}

export function account(userId: string): AccountRef {
  return { platform: PLATFORM, id: userId };
}

export function contextKey(guild: string | null, channel: string, kind: ContextKind): ContextKey {
  return { platform: PLATFORM, scope: guild, channel, kind };
}

/**
 * Context kind of a channel type. Text chat in voice channels counts as a normal channel; voice
 * contexts belong to the voice node.
 */
export function kindOf(channel: ChannelType): ContextKind {
  switch (channel) {
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return "thread";
    case ChannelType.DM:
    case ChannelType.GroupDM:
      return "dm";
    default:
      return "channel";
  }
}

export interface UserLike {
  id: string;
  username: string;
  globalName?: string | null;
  bot?: boolean;
}

/** Guild nickname > global display name > username. */
export function displayName(user: UserLike, nick?: string | null): string {
  const first = nick ?? user.globalName;
  return first !== undefined && first !== null && first.trim() !== "" ? first : user.username;
}

export interface AttachmentLike {
  url: string;
  name: string;
  contentType?: string | null;
}

/** The parts of a discord.js `Message` that `incomingMessage` reads. */
export interface MessageLike {
  id: string;
  channelId: string;
  guildId: string | null;
  author: UserLike;
  /** Guild member (nickname), when the message came from a guild. */
  member?: { nickname?: string | null } | null;
  content: string;
  createdTimestamp: number;
  mentions: { users: { keys(): Iterable<string> } };
  attachments: { values(): Iterable<AttachmentLike> };
}

/**
 * Maps a gateway message. `selfIds` are all of her accounts (bot and self account);
 * `repliedAuthorId` is the author of the message this one replies to, if it is a reply.
 */
export function incomingMessage(
  msg: MessageLike,
  kind: ContextKind,
  selfIds: ReadonlySet<string>,
  repliedAuthorId: string | null = null,
): IncomingMessage {
  const effectiveKind: ContextKind = msg.guildId === null ? "dm" : kind;
  const attachments: Attachment[] = [];
  for (const a of msg.attachments.values()) {
    attachments.push({ url: a.url, filename: a.name, content_type: a.contentType ?? null });
  }
  let mentionsSelf = false;
  for (const id of msg.mentions.users.keys()) {
    if (selfIds.has(id)) {
      mentionsSelf = true;
      break;
    }
  }
  return {
    id: {
      context: contextKey(msg.guildId, msg.channelId, effectiveKind),
      id: msg.id,
    },
    author: {
      account: account(msg.author.id),
      display_name: displayName(msg.author, msg.member?.nickname ?? null),
      is_bot: msg.author.bot ?? false,
    },
    text: msg.content,
    mentions_self: mentionsSelf,
    reply_to_self: repliedAuthorId !== null && selfIds.has(repliedAuthorId),
    attachments,
    ts: toTimestamp(msg.createdTimestamp),
  };
}

/** Permissions as discord.js or the raw API hands them out. */
export type PermissionsLike = string | bigint | { bitfield: bigint } | null | undefined;

function permissionBits(p: PermissionsLike): bigint {
  if (p === null || p === undefined) return 0n;
  if (typeof p === "bigint") return p;
  if (typeof p === "string") return p === "" ? 0n : BigInt(p);
  return p.bitfield;
}

/** Administrator or Manage Server count as guild admin. */
export function isAdminPermissions(p: PermissionsLike): boolean {
  return (permissionBits(p) & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
}

/** Role ids of a guild member, as strings. */
export function roleIds(roles: readonly string[]): string[] {
  return [...roles];
}

/** A guild member as the gateway cache (`GuildMember`) or the raw API payload gives it. */
export interface MemberLike {
  nickname?: string | null;
  nick?: string | null;
  roles: readonly string[] | { cache: { keys(): Iterable<string> } };
  permissions?: PermissionsLike;
}

export function memberNick(member: MemberLike | null | undefined): string | null {
  return member?.nickname ?? member?.nick ?? null;
}

export function memberRoleIds(member: MemberLike | null | undefined): string[] {
  if (!member) return [];
  const roles = member.roles;
  return Array.isArray(roles)
    ? [...(roles as readonly string[])]
    : [...(roles as { cache: { keys(): Iterable<string> } }).cache.keys()];
}

/** Members with Administrator or Manage Server count as guild admins. */
export function isGuildAdmin(member: MemberLike | null | undefined): boolean {
  return member !== null && member !== undefined && isAdminPermissions(member.permissions);
}

/** The resolved part of an interaction (`interaction.options.resolved`). */
export interface ResolvedLike {
  users?: { entries(): Iterable<[string, UserLike]> } | null;
  members?: { get(id: string): MemberLike | null | undefined } | null;
}

/**
 * Guild details of the users passed in user options, keyed by user id. Users without member
 * data (e.g. in DMs) get no roles.
 */
export function resolvedUsers(
  resolved: ResolvedLike | null | undefined,
): Map<string, ResolvedUser> {
  const out = new Map<string, ResolvedUser>();
  if (!resolved?.users) return out;
  for (const [id, user] of resolved.users.entries()) {
    const member = resolved.members?.get(id);
    out.set(id, {
      display_name: displayName(user, memberNick(member)),
      platform_roles: memberRoleIds(member),
      is_guild_admin: member ? isAdminPermissions(member.permissions) : false,
    });
  }
  return out;
}

/** One option of an interaction (`CommandInteractionOption`). */
export interface OptionLike {
  name: string;
  type: ApplicationCommandOptionType;
  value?: string | number | boolean;
  options?: readonly OptionLike[];
}

/** An argument value: strings, integers and booleans, like the commands crate's `ArgValue`. */
export type ArgValueLike = string | number | boolean;

/** Flattens an interaction into a command path and argument values. */
export function commandPath(
  name: string,
  options: readonly OptionLike[],
): { path: string[]; args: Map<string, ArgValueLike> } {
  const path = [name];
  let level = options;
  for (;;) {
    const first = level[0];
    if (
      !first ||
      (first.type !== ApplicationCommandOptionType.Subcommand &&
        first.type !== ApplicationCommandOptionType.SubcommandGroup)
    ) {
      break;
    }
    path.push(first.name);
    level = first.options ?? [];
  }
  const args = new Map<string, ArgValueLike>();
  for (const option of level) {
    const value = argValue(option);
    if (value !== undefined) args.set(option.name, value);
  }
  return { path, args };
}

function argValue(option: OptionLike): ArgValueLike | undefined {
  const value = option.value;
  if (value === undefined) return undefined;
  switch (option.type) {
    case ApplicationCommandOptionType.Integer:
      return typeof value === "number" ? value : undefined;
    case ApplicationCommandOptionType.Boolean:
      return typeof value === "boolean" ? value : undefined;
    case ApplicationCommandOptionType.Subcommand:
    case ApplicationCommandOptionType.SubcommandGroup:
      return undefined;
    default:
      // String, Number (as text), and the id of users, channels, roles, mentionables, attachments.
      return String(value);
  }
}

/** Parses a non-zero Discord snowflake. */
export function snowflake(raw: string, what: string): string {
  if (/^[0-9]{1,20}$/.test(raw) && BigInt(raw) !== 0n) return raw;
  throw new Error(`invalid Discord ${what} id \`${raw}\``);
}

/** Parses configured account ids (`"123"` or `"discord:123"`). */
export function parseUserIds(ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const s of ids) {
    let raw = s.trim();
    if (raw.startsWith("discord:")) raw = raw.slice("discord:".length);
    if (!/^[0-9]{1,20}$/.test(raw) || BigInt(raw) === 0n) {
      throw new Error(`invalid Discord user id \`${s}\``);
    }
    out.add(BigInt(raw).toString());
  }
  return out;
}
