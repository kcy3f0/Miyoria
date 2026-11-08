// `/me wallet`, `/me checkin`, `/me feed`: the coin wallet in Discord (docs/design/economy.md §7).
//
// The `/me i` panel has a wallet page (status line `me wallet`, buttons that run `me checkin` /
// `me feed`), and `me wallet` also carries the same three buttons when run on its own. Same
// ledger and daily limits as the web panel. Every answer is a neutral system card (public
// unless `[modules.commands.visibility]` says otherwise); her own reaction to being fed is her
// normal message.

import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  type CardBlock,
  type CardButton,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  defineRoute,
  type Invocation,
  notice,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import { newId } from "@miyoria/types";
import { STRANGER, WALLET_NODE } from "./economy.js";
import {
  type Economy,
  EconomyError,
  EconomyKey,
  FEED_ITEMS,
  type FeedItem,
  type Hunger,
  type WalletView,
} from "./types.js";

const log = getLogger("economy.commands");

export const PATHS = ["me wallet", "me checkin", "me feed"] as const;

const R = {
  checkin: "me:wallet:checkin",
  feed: "me:wallet:feed",
} as const;

const HUNGER_WORD: Readonly<Record<Hunger, string>> = {
  full: "吃飽了",
  ok: "還不餓",
  hungry: "有點餓",
  starving: "餓壞了",
};

const UNAVAILABLE = "錢包現在打不開";

/** Buttons of the wallet card: label of `me feed <item>` (dessert is web only). */
const FEED_BUTTONS: readonly { item: FeedItem; label: string }[] = [
  { item: "rice", label: "餵一碗" },
  { item: "big_bowl", label: "餵鋼盆" },
];

function isFeedItem(raw: string | null | undefined): raw is FeedItem {
  return FEED_ITEMS.includes(raw as FeedItem);
}

/** The wallet as text: balance, today, check-in, her hunger, what is left to earn. */
export function walletText(view: WalletView): string {
  const lines = [
    `**${view.balance} ${view.currency}**　今天賺了 ${view.today_earned}`,
    view.checked_in_today
      ? `簽到：今天已簽到，連續 ${view.streak} 天`
      : view.streak > 0
        ? `簽到：今天還沒簽到，連續 ${view.streak} 天`
        : "簽到：今天還沒簽到",
  ];
  if (view.hungry !== null) lines.push(`她現在：${HUNGER_WORD[view.hungry]}`);
  const left = view.earn
    .filter((e) => e.reason !== "her_gift" && e.cap - e.earned_today > 0)
    .filter((e) => e.reason !== "checkin" || !view.checked_in_today)
    .map((e) => `・${e.label}：還能賺 ${e.cap - e.earned_today}`);
  lines.push(left.length > 0 ? `今天還能賺\n${left.join("\n")}` : "今天能賺的都賺完了");
  return lines.join("\n");
}

/** A neutral result card (written into the `/me i` panel when pressed there). */
function result(text: string): CommandReply {
  return cardReply([{ type: "text", text }], { accent: "neutral" });
}

class Handler {
  constructor(readonly services: ServiceLookup) {}

  /** An economy answer: refusals (stranger, limits, full) are plain information, not errors. */
  async #guard(run: (economy: Economy) => Promise<CommandReply>): Promise<CommandReply> {
    const economy = this.services.get(EconomyKey);
    if (!economy) return notice("warn", UNAVAILABLE);
    try {
      return await run(economy);
    } catch (error) {
      if (error instanceof EconomyError) {
        return error.status === 503 ? notice("warn", error.message) : notice("info", error.message);
      }
      log.warn({ error: errorMessage(error) }, "wallet command failed");
      return notice("warn", UNAVAILABLE);
    }
  }

  wallet(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const view = await economy.wallet(inv.invoker);
      // A stranger or a blocked person: the same plain line as the web page, no buttons.
      if (!view.can_earn) return notice("info", STRANGER);
      const price = (item: FeedItem) => view.shop.find((s) => s.id === item);
      const blocks: CardBlock[] = [
        { type: "text", text: walletText(view) },
        {
          type: "buttons",
          buttons: [
            {
              id: componentId(R.checkin),
              label: "簽到",
              style: "primary",
              disabled: view.checked_in_today,
            },
            ...FEED_BUTTONS.map(
              ({ item, label }): CardButton => ({
                id: componentId(R.feed, item),
                label,
                disabled: price(item)?.available === false,
              }),
            ),
          ],
        },
      ];
      const prices = FEED_BUTTONS.map(({ item, label }) => {
        const shop = price(item);
        return shop ? `${label} ${shop.price}` : null;
      }).filter((t) => t !== null);
      if (prices.length > 0)
        blocks.push({ type: "muted", text: `${prices.join("・")} ${view.currency}` });
      return cardReply(blocks, { accent: "neutral", title: "錢包" });
    });
  }

  checkin(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const r = await economy.checkin(inv.invoker);
      const view = await economy.wallet(inv.invoker);
      return result(
        `簽到了，+${r.gained} ${view.currency}。連續 ${r.streak} 天，現在有 ${r.balance} ${view.currency}。`,
      );
    });
  }

  feed(inv: Invocation, item: FeedItem): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      // The platform does not hand a command its interaction id, so a press is its own key.
      const r = await economy.feed(inv.invoker, item, 1, `discord:${newId()}`);
      if (!r.accepted) return result(r.message);
      const view = await economy.wallet(inv.invoker);
      return result(`${r.message}，花了 ${r.charged} ${view.currency}，剩 ${r.balance}。`);
    });
  }
}

function unregister(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}

function register(registry: CommandRegistry, handler: Handler): void {
  const routes: AnyComponentRoute[] = [
    {
      route: R.checkin,
      handle: async (inv) => ComponentResult.reply(await handler.checkin(inv)),
    },
    defineRoute<FeedItem>({
      route: R.feed,
      parse: (p) => (isFeedItem(p[0]) ? p[0] : null),
      handle: async (inv, item) => ComponentResult.reply(await handler.feed(inv, item)),
    }),
  ];
  registry.register(
    commandSpec("me wallet", "你的魚幣：餘額、今天還能賺多少，可以簽到和餵她", {
      permission: WALLET_NODE,
    }),
    (inv) => handler.wallet(inv),
    { components: routes },
  );
  registry.register(
    commandSpec("me checkin", "每日簽到，領魚幣", { permission: WALLET_NODE }),
    (inv) => handler.checkin(inv),
  );
  registry.register(
    commandSpec("me feed", "用魚幣餵她一碗飯", {
      args: [argSpec("item", "要餵什麼", ArgKind.choice(FEED_ITEMS))],
      permission: WALLET_NODE,
    }),
    (inv) => {
      const item = inv.str("item");
      return isFeedItem(item)
        ? handler.feed(inv, item)
        : Promise.resolve(notice("warn", "沒有這種食物"));
    },
  );
}

/**
 * Remembers which registry the commands went into, so they can be removed on stop and
 * re-registered when the `commands` module provides a different registry.
 */
export class EconomyCommands {
  #installed: CommandRegistry | null = null;

  /** Registers the commands in `registry` unless already there. */
  install(registry: CommandRegistry, services: ServiceLookup): void {
    if (this.#installed === registry) return;
    if (this.#installed !== null) {
      unregister(this.#installed);
      this.#installed = null;
    }
    try {
      register(registry, new Handler(services));
      this.#installed = registry;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not register wallet commands");
      unregister(registry);
    }
  }

  uninstall(): void {
    if (this.#installed !== null) {
      unregister(this.#installed);
      this.#installed = null;
    }
  }
}
