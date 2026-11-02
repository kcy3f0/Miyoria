// Presence opt-out: `/me privacy presence:off` and the `PresencePrivacy` service the platform
// modules ask before publishing someone's presence. The choice is stored in the shared
// per-person privacy record (`privacy:<platform>:<id>` under `_global`, see `@miyoria/types`).

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  type CommandReply,
  commandSpec,
  notice,
} from "@miyoria/commands";
import { errorMessage, getLogger } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  accountRefString,
  mergePrivacy,
  PRIVACY_PREFIX,
  PRIVACY_PROFILE,
  type PresencePrivacy,
  parsePrivacy,
  privacyAccount,
  privacyKey,
} from "@miyoria/types";

const log = getLogger("world.privacy");

/** Paths registered by `registerPrivacyCommands`. */
export const PRIVACY_PATHS: readonly string[] = ["me privacy"];

/**
 * Who opted out of presence, loaded once and kept in memory so lookups are synchronous. Until
 * the records are loaded every presence is refused (fail closed).
 */
export class PrivacyBook implements PresencePrivacy {
  readonly #denied = new Set<string>();
  #loaded: boolean;

  constructor(private readonly store: SettingsStore | null) {
    this.#loaded = store === null;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  /** Reads every privacy record. Returns whether it worked (otherwise presence stays refused). */
  async load(): Promise<boolean> {
    if (!this.store) return true;
    try {
      const records = await this.store.list(PRIVACY_PROFILE, PRIVACY_PREFIX);
      this.#denied.clear();
      for (const [key, value] of records) {
        const account = privacyAccount(key);
        if (account && !parsePrivacy(value).presence) this.#denied.add(accountRefString(account));
      }
      this.#loaded = true;
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read privacy settings; ignoring presence");
    }
    return this.#loaded;
  }

  presenceAllowed(account: AccountRef): boolean {
    return this.#loaded && !this.#denied.has(accountRefString(account));
  }

  /** Records `account`'s choice, keeping the other fields of their record. */
  async setPresence(account: AccountRef, allowed: boolean): Promise<void> {
    if (this.store) {
      const key = privacyKey(account);
      const existing = await this.store.get(PRIVACY_PROFILE, key);
      await this.store.set(PRIVACY_PROFILE, key, mergePrivacy(existing, { presence: allowed }));
    }
    if (allowed) this.#denied.delete(accountRefString(account));
    else this.#denied.add(accountRefString(account));
  }
}

const ALLOWED_TEXT = "她可以看到你在 Discord 上的狀態（在線、遊戲、音樂、自訂狀態）。";
const DENIED_TEXT = "她不會讀取你在 Discord 上的狀態（在線、遊戲、音樂、自訂狀態）。";
const OFF_HINT = "不想讓她看到的話,請使用 `/me privacy presence:off`。";
const ON_HINT = "要讓她看到的話,請使用 `/me privacy presence:on`。";

function privacyReply(allowed: boolean, changed: boolean): CommandReply {
  if (changed) return notice("success", allowed ? ALLOWED_TEXT : DENIED_TEXT);
  return notice("info", allowed ? ALLOWED_TEXT : DENIED_TEXT, allowed ? OFF_HINT : ON_HINT);
}

/**
 * `/me privacy [presence:on|off]`. `onDenied` runs after someone opted out, so state already
 * collected about them is dropped too.
 */
export function registerPrivacyCommands(
  registry: CommandRegistry,
  book: PrivacyBook,
  onDenied: (account: AccountRef) => void,
): void {
  registry.register(
    commandSpec("me privacy", "查看或設定她能不能看到你在 Discord 上的狀態", {
      args: [
        argSpec(
          "presence",
          "on = 可以看（在線、遊戲、音樂、自訂狀態），off = 不要看（省略 = 查看目前設定）",
          ArgKind.choice(["on", "off"]),
          { required: false },
        ),
      ],
      permission: "me.privacy",
      ephemeral: true,
    }),
    async (inv) => {
      if (!book.loaded) return notice("error", "隱私設定暫時無法讀取，請稍後再試。");
      const state = inv.str("presence");
      if (state === null) return privacyReply(book.presenceAllowed(inv.invoker), false);
      const allowed = state === "on";
      await book.setPresence(inv.invoker, allowed);
      if (!allowed) onDenied(inv.invoker);
      return privacyReply(allowed, true);
    },
  );
}

export function unregisterPrivacyCommands(registry: CommandRegistry): void {
  for (const path of PRIVACY_PATHS) registry.unregister(path);
}
