import {
  ArgKind,
  type ArgSpec,
  argSpec,
  CommandRegistry,
  CommandReply,
  commandSpec,
  type Invocation,
} from "@miyoria/commands";
import { ApplicationCommandOptionType, MessageFlags } from "discord.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type CommandInteractionLike,
  DEFER_AFTER_MS,
  HANDLER_FAILED_TEXT,
  handleCommandInteraction,
  invocationFromInteraction,
} from "../src/interaction.js";

afterEach(() => {
  vi.useRealTimers();
});

interface Sent {
  call: "reply" | "deferReply" | "editReply" | "followUp" | "deleteReply";
  options?: Record<string, unknown>;
}

function interaction(overrides: Partial<CommandInteractionLike> = {}): {
  i: CommandInteractionLike;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const record =
    (call: Sent["call"]) =>
    async (options?: unknown): Promise<undefined> => {
      sent.push({ call, options: options as Record<string, unknown> | undefined });
    };
  const i: CommandInteractionLike = {
    commandName: "ping",
    user: { id: "42", username: "alice_w", globalName: "Alice" },
    guildId: "300",
    channelId: "200",
    member: { nickname: "Ali", roles: ["70", "71"], permissions: "8" },
    options: { data: [] },
    reply: record("reply"),
    deferReply: record("deferReply"),
    editReply: record("editReply"),
    followUp: record("followUp"),
    deleteReply: record("deleteReply"),
    ...overrides,
  };
  return { i, sent };
}

function registryWith(
  path: string,
  handler: (inv: Invocation) => CommandReply | Promise<CommandReply>,
  options: { ephemeral?: boolean; args?: ArgSpec[] } = {},
): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(commandSpec(path, "test", options), handler);
  return registry;
}

describe("invocationFromInteraction", () => {
  test("maps_the_interaction_to_an_invocation", () => {
    const { i } = interaction({
      commandName: "admin",
      options: {
        data: [
          {
            name: "role",
            type: ApplicationCommandOptionType.SubcommandGroup,
            options: [
              {
                name: "assign",
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                  { name: "user", type: ApplicationCommandOptionType.User, value: "5" },
                  { name: "role", type: ApplicationCommandOptionType.String, value: "moderator" },
                ],
              },
            ],
          },
        ],
        resolved: {
          users: new Map([["5", { id: "5", username: "eve", globalName: "Eve" }]]),
          members: new Map([["5", { nick: "Evie", roles: ["9"], permissions: "32" }]]),
        },
      },
    });
    expect(invocationFromInteraction(i, "channel")).toEqual({
      path: ["admin", "role", "assign"],
      args: { user: "5", role: "moderator" },
      invoker: { platform: "discord", id: "42" },
      invoker_display_name: "Ali",
      context: { platform: "discord", scope: "300", channel: "200", kind: "channel" },
      invoker_is_guild_admin: true,
      platform_roles: ["70", "71"],
      resolved_users: {
        "5": { display_name: "Evie", platform_roles: ["9"], is_guild_admin: true },
      },
    });
  });

  test("dm_invocations_have_no_guild_details", () => {
    const { i } = interaction({ guildId: null, member: null });
    const inv = invocationFromInteraction(i, "dm");
    expect(inv.context).toEqual({ platform: "discord", scope: null, channel: "200", kind: "dm" });
    expect(inv.invoker_is_guild_admin).toBe(false);
    expect(inv.platform_roles).toEqual([]);
    expect(inv.invoker_display_name).toBe("Alice");
  });
});

describe("handleCommandInteraction", () => {
  test("fast_commands_reply_directly", async () => {
    const registry = registryWith("ping", () => CommandReply.public("pong"));
    const { i, sent } = interaction();
    await handleCommandInteraction(registry, i, "channel");
    expect(sent).toEqual([
      {
        call: "reply",
        options: { content: "pong", flags: undefined, allowedMentions: { parse: [] } },
      },
    ]);
  });

  test("ephemeral_replies_set_the_flag", async () => {
    const registry = registryWith("ping", () => CommandReply.ephemeral("secret"));
    const { i, sent } = interaction();
    await handleCommandInteraction(registry, i, "channel");
    expect(sent[0]?.options?.flags).toBe(MessageFlags.Ephemeral);
  });

  test("slow_commands_are_deferred_after_1_5_seconds_and_edited", async () => {
    vi.useFakeTimers();
    let finish: (reply: CommandReply) => void = () => undefined;
    const registry = registryWith(
      "ping",
      () => new Promise<CommandReply>((resolve) => (finish = resolve)),
      { ephemeral: true },
    );
    const { i, sent } = interaction();
    const done = handleCommandInteraction(registry, i, "channel");
    await vi.advanceTimersByTimeAsync(DEFER_AFTER_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // Deferred with the spec's default visibility.
    expect(sent).toEqual([{ call: "deferReply", options: { flags: MessageFlags.Ephemeral } }]);
    finish(CommandReply.ephemeral("done"));
    await done;
    expect(sent.map((s) => s.call)).toEqual(["deferReply", "editReply"]);
    expect(sent[1]?.options).toEqual({ content: "done", allowedMentions: { parse: [] } });
  });

  test("a_deferred_reply_with_other_visibility_is_replaced", async () => {
    vi.useFakeTimers();
    let finish: (reply: CommandReply) => void = () => undefined;
    // Spec default is public, but the handler answers ephemerally.
    const registry = registryWith("ping", () => new Promise<CommandReply>((r) => (finish = r)));
    const { i, sent } = interaction();
    const done = handleCommandInteraction(registry, i, "channel");
    await vi.advanceTimersByTimeAsync(DEFER_AFTER_MS);
    expect(sent).toEqual([{ call: "deferReply", options: { flags: undefined } }]);
    finish(CommandReply.ephemeral("only you"));
    await done;
    expect(sent.map((s) => s.call)).toEqual(["deferReply", "followUp", "deleteReply"]);
    expect(sent[1]?.options?.flags).toBe(MessageFlags.Ephemeral);
  });

  test("long_replies_are_split_into_followups", async () => {
    const registry = registryWith("ping", () => CommandReply.public("x".repeat(4500)));
    const { i, sent } = interaction();
    await handleCommandInteraction(registry, i, "channel");
    expect(sent.map((s) => s.call)).toEqual(["reply", "followUp", "followUp"]);
    const lengths = sent.map((s) => String(s.options?.content).length);
    expect(lengths).toEqual([2000, 2000, 500]);
  });

  test("empty_replies_show_an_ellipsis", async () => {
    const registry = registryWith("ping", () => CommandReply.public(""));
    const { i, sent } = interaction();
    await handleCommandInteraction(registry, i, "channel");
    expect(sent[0]?.options?.content).toBe("……");
  });

  test("handler_failures_become_an_ephemeral_error_reply", async () => {
    const registry = registryWith("ping", () => {
      throw new Error("boom");
    });
    const { i, sent } = interaction();
    await handleCommandInteraction(registry, i, "channel");
    expect(sent[0]?.call).toBe("reply");
    expect(sent[0]?.options?.content).toBe(HANDLER_FAILED_TEXT);
    expect(sent[0]?.options?.flags).toBe(MessageFlags.Ephemeral);
  });

  test("unknown_commands_get_the_registry_message", async () => {
    const { i, sent } = interaction({ commandName: "nope" });
    await handleCommandInteraction(new CommandRegistry(), i, "channel");
    expect(String(sent[0]?.options?.content)).toContain("沒有「nope」這個指令啦");
  });

  test("response_failures_are_swallowed", async () => {
    const registry = registryWith("ping", () => CommandReply.public("pong"));
    const { i } = interaction({
      reply: async () => {
        throw new Error("Unknown interaction");
      },
    });
    await expect(handleCommandInteraction(registry, i, "channel")).resolves.toBeUndefined();
  });

  test("arguments_and_user_details_reach_the_handler", async () => {
    let seen: Invocation | undefined;
    const registry = registryWith(
      "echo",
      (inv) => {
        seen = inv;
        return CommandReply.public(`${inv.str("text")} ${inv.int("n")} ${inv.account("who")?.id}`);
      },
      {
        args: [
          argSpec("text", "t", ArgKind.string),
          argSpec("n", "n", ArgKind.integer),
          argSpec("who", "w", ArgKind.user),
        ],
      },
    );
    const { i, sent } = interaction({
      commandName: "echo",
      options: {
        data: [
          { name: "text", type: ApplicationCommandOptionType.String, value: "hi" },
          { name: "n", type: ApplicationCommandOptionType.Integer, value: 3 },
          { name: "who", type: ApplicationCommandOptionType.User, value: "5" },
        ],
      },
    });
    await handleCommandInteraction(registry, i, "channel");
    expect(sent[0]?.options?.content).toBe("hi 3 5");
    expect(seen?.invoker_is_guild_admin).toBe(true);
    expect(seen?.platform_roles).toEqual(["70", "71"]);
  });
});
