// `/me wallet`, `/me checkin`, `/me feed` and the wallet buttons, against a fake `Economy`.

import {
  type CardBlock,
  CommandRegistry,
  type CommandReply,
  Permissions,
  panelDefs,
  replyEphemeral,
} from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/kernel";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands, PATHS, walletText } from "../src/commands.js";
import { STRANGER } from "../src/economy.js";
import {
  type Economy,
  EconomyError,
  EconomyKey,
  type FeedItem,
  type WalletView,
} from "../src/types.js";

const ctx: ContextKey = { platform: "discord", scope: null, channel: "9", kind: "dm" };
const acct = (id: string): AccountRef => ({ platform: "discord", id });

function view(over: Partial<WalletView> = {}): WalletView {
  return {
    currency: "魚幣",
    balance: 120,
    can_earn: true,
    today_earned: 30,
    checked_in_today: false,
    streak: 2,
    earn: [
      { reason: "checkin", label: "每日簽到", amount: 10, earned_today: 0, cap: 10 },
      { reason: "talked", label: "和她說話", amount: 10, earned_today: 10, cap: 10 },
      { reason: "voice", label: "在語音陪她", amount: 2, earned_today: 4, cap: 20 },
      { reason: "her_gift", label: "她送你的", amount: 0, earned_today: 0, cap: 30 },
    ],
    shop: [
      { id: "rice", kind: "feed", label: "一碗白飯", price: 10, available: true, why: null },
      { id: "big_bowl", kind: "feed", label: "一大碗白飯", price: 40, available: true, why: null },
    ],
    frames: { owned: [], selected: null },
    hungry: "hungry",
    recent: [],
    deals: [],
    ...over,
  };
}

interface Fake {
  economy: Economy;
  calls: string[];
  state: { view: WalletView; fail: EconomyError | null; full: boolean };
}

function fake(): Fake {
  const calls: string[] = [];
  const state = { view: view(), fail: null as EconomyError | null, full: false };
  const economy = {
    wallet: async () => state.view,
    checkin: async () => {
      calls.push("checkin");
      if (state.fail) throw state.fail;
      return { gained: 10, streak: 3, balance: 130 };
    },
    feed: async (_a: AccountRef, item: FeedItem, count: number, key: string) => {
      calls.push(`feed:${item}:${count}:${key}`);
      if (state.fail) throw state.fail;
      if (state.full) {
        return { accepted: false, eaten: 0, charged: 0, balance: 120, message: "她吃飽了,吃不下" };
      }
      return { accepted: true, eaten: 1, charged: 10, balance: 110, message: "她吃了一碗白飯" };
    },
  } as unknown as Economy;
  return { economy, calls, state };
}

function setup(withEconomy = true) {
  const f = fake();
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  const services = new ServiceRegistry();
  if (withEconomy) services.provide("test", EconomyKey, f.economy);
  new EconomyCommands().install(registry, services);
  return { ...f, registry };
}

function run(registry: CommandRegistry, path: string, args: Record<string, string> = {}) {
  return registry.dispatch({
    path: path.split(" "),
    args,
    invoker: acct("5"),
    invoker_display_name: "Bob",
    context: ctx,
    invoker_is_guild_admin: false,
  });
}

function press(registry: CommandRegistry, customId: string) {
  return registry.dispatchComponent({
    custom_id: customId,
    invoker: acct("5"),
    invoker_display_name: "Bob",
    context: ctx,
    invoker_is_guild_admin: false,
  });
}

function replyOf(outcome: Awaited<ReturnType<typeof press>>): CommandReply {
  const result = outcome?.result;
  if (result?.type !== "reply") throw new Error("expected a reply");
  return result.reply;
}

function buttons(reply: CommandReply) {
  return (reply.card?.blocks ?? [])
    .filter((b): b is Extract<CardBlock, { type: "buttons" }> => b.type === "buttons")
    .flatMap((b) => b.buttons);
}

describe("wallet commands", () => {
  it("wallet_card_shows_balance_hunger_and_what_is_left", async () => {
    const { registry } = setup();
    const reply = await run(registry, "me wallet");
    // The wallet answers the channel; a warning or error would still be ephemeral.
    expect(replyEphemeral(registry.get(["me", "wallet"])?.ephemeral ?? true, reply)).toBe(false);
    expect(reply.card?.accent).toBe("neutral");
    expect(reply.text).toContain("120 魚幣");
    expect(reply.text).toContain("今天賺了 30");
    expect(reply.text).toContain("今天還沒簽到，連續 2 天");
    expect(reply.text).toContain("她現在：有點餓");
    // Only what can still be earned: talked is at its cap, her gift is not on demand.
    expect(reply.text).toContain("每日簽到：還能賺 10");
    expect(reply.text).toContain("在語音陪她：還能賺 16");
    expect(reply.text).not.toContain("和她說話：還能賺");
    expect(reply.text).not.toContain("她送你的");
    expect(buttons(reply).map((b) => b.label)).toEqual(["簽到", "餵一碗", "餵鋼盆"]);
    expect(buttons(reply).every((b) => b.disabled !== true)).toBe(true);
    // Her hunger is words, never the number.
    expect(reply.text).not.toMatch(/0\.\d/);
  });

  it("wallet_card_disables_what_cannot_be_pressed", async () => {
    const { registry, state } = setup();
    state.view = view({
      checked_in_today: true,
      shop: view().shop.map((s) => (s.id === "big_bowl" ? { ...s, available: false } : s)),
    });
    const reply = await run(registry, "me wallet");
    expect(reply.text).toContain("今天已簽到，連續 2 天");
    expect(reply.text).not.toContain("每日簽到：還能賺");
    expect(buttons(reply).map((b) => [b.label, b.disabled === true])).toEqual([
      ["簽到", true],
      ["餵一碗", false],
      ["餵鋼盆", true],
    ]);
  });

  it("strangers_get_the_plain_line_and_no_buttons", async () => {
    const { registry, state } = setup();
    state.view = view({ can_earn: false, balance: 0, hungry: null });
    const reply = await run(registry, "me wallet");
    expect(reply.text).toBe(STRANGER);
    expect(buttons(reply)).toEqual([]);
    expect(reply.tone).toBe("info");
  });

  it("buttons_check_in_and_feed_with_a_neutral_card", async () => {
    const { registry, calls } = setup();
    const checkin = await press(registry, "mi:me:wallet:checkin");
    expect(checkin?.ephemeral).toBe(false);
    const cr = replyOf(checkin);
    expect(cr.text).toContain("+10 魚幣");
    expect(cr.text).toContain("連續 3 天");
    expect(cr.card?.accent).toBe("neutral");

    const fr = replyOf(await press(registry, "mi:me:wallet:feed:big_bowl"));
    expect(fr.text).toContain("她吃了一碗白飯");
    expect(fr.text).toContain("剩 110");
    expect(calls[0]).toBe("checkin");
    expect(calls[1]).toMatch(/^feed:big_bowl:1:discord:/);

    // A forged item is refused before it reaches the ledger.
    expect(replyOf(await press(registry, "mi:me:wallet:feed:gold")).tone).toBe("error");
    expect(calls).toHaveLength(2);
  });

  it("refusals_are_neutral_information", async () => {
    const { registry, state } = setup();
    state.full = true;
    const full = await run(registry, "me feed", { item: "rice" });
    expect(full.text).toBe("她吃飽了,吃不下");
    expect(full.tone).toBeUndefined();
    expect(full.card?.accent).toBe("neutral");

    state.fail = new EconomyError(409, "今天已經簽到過了");
    const again = await run(registry, "me checkin");
    expect(again.text).toBe("今天已經簽到過了");
    expect(again.tone).toBe("info");

    state.fail = new EconomyError(402, "魚幣不夠");
    expect((await run(registry, "me feed", { item: "big_bowl" })).tone).toBe("info");

    state.fail = new EconomyError(403, STRANGER);
    expect((await run(registry, "me feed", { item: "rice" })).text).toBe(STRANGER);

    state.fail = new EconomyError(503, "現在沒辦法餵她");
    expect((await run(registry, "me feed", { item: "rice" })).tone).toBe("warn");
  });

  it("without_the_economy_the_commands_say_so", async () => {
    const { registry } = setup(false);
    const reply = await run(registry, "me wallet");
    expect(reply.tone).toBe("warn");
    expect(reply.text).toContain("錢包現在打不開");
  });

  it("install_is_idempotent_and_uninstall_removes_everything", () => {
    const f = fake();
    const registry = new CommandRegistry(Permissions.fromStrings([]));
    const services = new ServiceRegistry();
    services.provide("test", EconomyKey, f.economy);
    const commands = new EconomyCommands();
    commands.install(registry, services);
    commands.install(registry, services);
    for (const path of PATHS) expect(registry.get(path.split(" "))).toBeDefined();
    commands.uninstall();
    for (const path of PATHS) expect(registry.get(path.split(" "))).toBeUndefined();
  });

  it("the_me_panel_has_a_wallet_page_over_these_commands", () => {
    const me = panelDefs().find((d) => d.command === "me");
    const page = me?.pages.find((p) => p.id === "wallet");
    expect(page?.status?.map((s) => s.path)).toEqual(["me wallet"]);
    expect(page?.actions.map((a) => [a.label, a.path, a.args])).toEqual([
      ["簽到", "me checkin", undefined],
      ["餵一碗", "me feed", { item: "rice" }],
      ["餵鋼盆", "me feed", { item: "big_bowl" }],
    ]);
  });

  it("a_new_person_has_no_streak_noise", () => {
    expect(walletText(view({ streak: 0 }))).toContain("簽到：今天還沒簽到\n");
  });
});
