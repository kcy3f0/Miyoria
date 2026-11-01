import { ApplicationCommandOptionType, ChannelType } from "discord.js";
import { describe, expect, test } from "vitest";
import {
  commandPath,
  displayName,
  incomingMessage,
  isGuildAdmin,
  kindOf,
  type MemberLike,
  type MessageLike,
  type OptionLike,
  parseUserIds,
  resolvedUsers,
  snowflake,
  type UserLike,
} from "../src/mapping.js";

const user = (id: string, username: string, globalName: string | null, bot = false): UserLike => ({
  id,
  username,
  globalName,
  bot,
});

function message(extra: Partial<MessageLike> = {}): MessageLike {
  return {
    id: "1000",
    channelId: "200",
    guildId: "300",
    author: user("42", "alice_w", "Alice"),
    member: { nickname: "Ali" },
    content: "hi <@7>",
    createdTimestamp: Date.parse("2026-11-01T12:00:00.000Z"),
    mentions: { users: new Map() },
    attachments: new Map(),
    ...extra,
  };
}

const selves = () => parseUserIds(["7", "discord:8"]);

describe("mapping", () => {
  test("maps_guild_message", () => {
    const msg = message({
      mentions: { users: new Map([["7", user("7", "miyoria", null, true)]]) },
      attachments: new Map([
        ["5", { url: "https://cdn/cat.png", name: "cat.png", contentType: "image/png" }],
      ]),
    });
    const m = incomingMessage(msg, "thread", selves());
    expect(m.id.id).toBe("1000");
    expect(m.id.context).toEqual({
      platform: "discord",
      scope: "300",
      channel: "200",
      kind: "thread",
    });
    expect(m.author.display_name).toBe("Ali");
    expect(m.author.account).toEqual({ platform: "discord", id: "42" });
    expect(m.author.is_bot).toBe(false);
    expect(m.mentions_self).toBe(true);
    expect(m.reply_to_self).toBe(false);
    expect(m.attachments).toEqual([
      { url: "https://cdn/cat.png", filename: "cat.png", content_type: "image/png" },
    ]);
    expect(m.text).toBe("hi <@7>");
    expect(m.ts).toBe("2026-11-01T12:00:00.000Z");
  });

  test("maps_dm_reply_to_self_account", () => {
    const msg = message({ guildId: null, member: null });
    const m = incomingMessage(msg, "channel", selves(), "8");
    expect(m.id.context.kind).toBe("dm");
    expect(m.id.context.scope).toBeNull();
    expect(m.author.display_name).toBe("Alice");
    expect(m.reply_to_self).toBe(true);
    expect(m.mentions_self).toBe(false);
    // A reply to somebody else is not a reply to her.
    expect(incomingMessage(msg, "dm", selves(), "99").reply_to_self).toBe(false);
    expect(incomingMessage(msg, "dm", selves(), null).reply_to_self).toBe(false);
  });

  test("attachment_without_content_type_is_null", () => {
    const msg = message({ attachments: new Map([["5", { url: "u", name: "f" }]]) });
    expect(incomingMessage(msg, "channel", selves()).attachments[0]?.content_type).toBeNull();
  });

  test("display_name_fallbacks", () => {
    expect(displayName(user("1", "bob", null))).toBe("bob");
    expect(displayName(user("1", "bob", null), "Bobby")).toBe("Bobby");
    expect(displayName(user("1", "bob", "Bob!"))).toBe("Bob!");
    // A blank nickname does not fall through to the global name (like the legacy filter).
    expect(displayName(user("1", "bob", "Bob!"), " ")).toBe("bob");
  });

  test("flattens_subcommand_groups", () => {
    const options: OptionLike[] = [
      {
        name: "module",
        type: ApplicationCommandOptionType.SubcommandGroup,
        options: [
          {
            name: "enable",
            type: ApplicationCommandOptionType.Subcommand,
            options: [
              { name: "id", type: ApplicationCommandOptionType.String, value: "llm" },
              { name: "force", type: ApplicationCommandOptionType.Boolean, value: true },
              { name: "times", type: ApplicationCommandOptionType.Integer, value: 3 },
              { name: "ratio", type: ApplicationCommandOptionType.Number, value: 2.5 },
              { name: "who", type: ApplicationCommandOptionType.User, value: "55" },
              { name: "what", type: ApplicationCommandOptionType.Role, value: "66" },
            ],
          },
        ],
      },
    ];
    const { path, args } = commandPath("admin", options);
    expect(path).toEqual(["admin", "module", "enable"]);
    expect(Object.fromEntries(args)).toEqual({
      id: "llm",
      force: true,
      times: 3,
      ratio: "2.5",
      who: "55",
      what: "66",
    });

    const plain = commandPath("ping", []);
    expect(plain.path).toEqual(["ping"]);
    expect(plain.args.size).toBe(0);
  });

  test("guild_admin_detection", () => {
    const member = (permissions: string): MemberLike => ({ roles: [], permissions });
    expect(isGuildAdmin(member("8"))).toBe(true); // ADMINISTRATOR
    expect(isGuildAdmin(member("32"))).toBe(true); // MANAGE_GUILD
    expect(isGuildAdmin(member("2048"))).toBe(false); // SEND_MESSAGES
    expect(isGuildAdmin(null)).toBe(false);
    // discord.js GuildMember exposes a PermissionsBitField.
    expect(isGuildAdmin({ roles: [], permissions: { bitfield: 8n } })).toBe(true);
    expect(isGuildAdmin({ roles: [] })).toBe(false);
  });

  test("maps_resolved_users", () => {
    const resolved = {
      users: new Map([
        ["5", user("5", "eve", "Eve")],
        ["6", user("6", "dm_only", null)],
      ]),
      members: new Map<string, MemberLike>([
        ["5", { nick: "Evie", roles: ["70", "71"], permissions: "8" }],
      ]),
    };
    const users = resolvedUsers(resolved);
    expect(users.get("5")).toEqual({
      display_name: "Evie",
      platform_roles: ["70", "71"],
      is_guild_admin: true,
    });
    expect(users.get("6")).toEqual({
      display_name: "dm_only",
      platform_roles: [],
      is_guild_admin: false,
    });
    expect(resolvedUsers(null).size).toBe(0);
    // A discord.js GuildMember has a role manager with a cache.
    const gm = new Map<string, MemberLike>([
      ["5", { nickname: "Evie", roles: { cache: new Map([["3", {}]]) } }],
    ]);
    expect(resolvedUsers({ users: resolved.users, members: gm }).get("5")?.platform_roles).toEqual([
      "3",
    ]);
  });

  test("parses_user_ids", () => {
    expect(selves().size).toBe(2);
    expect(selves().has("8")).toBe(true);
    expect(() => parseUserIds(["abc"])).toThrow("invalid Discord user id `abc`");
    expect(() => parseUserIds(["0"])).toThrow("invalid Discord user id `0`");
    expect(parseUserIds([" discord:007 "])).toEqual(new Set(["7"]));
  });

  test("channel_kinds", () => {
    expect(kindOf(ChannelType.PublicThread)).toBe("thread");
    expect(kindOf(ChannelType.PrivateThread)).toBe("thread");
    expect(kindOf(ChannelType.AnnouncementThread)).toBe("thread");
    expect(kindOf(ChannelType.DM)).toBe("dm");
    expect(kindOf(ChannelType.GroupDM)).toBe("dm");
    expect(kindOf(ChannelType.GuildText)).toBe("channel");
    // Text chat inside a voice channel is a normal channel; voice belongs to the voice node.
    expect(kindOf(ChannelType.GuildVoice)).toBe("channel");
  });

  test("snowflake_parsing", () => {
    expect(snowflake("123456789012345678", "channel")).toBe("123456789012345678");
    expect(() => snowflake("0", "channel")).toThrow("invalid Discord channel id `0`");
    expect(() => snowflake("x1", "message")).toThrow("invalid Discord message id `x1`");
  });
});
