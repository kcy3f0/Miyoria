// Mod events (PROTOCOL.md §6) → `GameEvent`s. `data.text` is a short
// Traditional Chinese line for commentary; `important` marks what is worth
// reacting to right away.

import type { GameEvent } from "@miyoria/sdk";
import type { BridgeEvent } from "./bridge.js";
import { zh } from "./names.js";

export interface EventOptions {
  /** Damage of at least this many points is important. */
  damageImportant?: number;
}

/** Hostile mobs worth a shout the moment they show up. */
const DANGEROUS = new Set(["creeper", "warden", "wither", "ender_dragon", "ravager", "evoker", "witch", "phantom"]);
/** Pickups worth a comment. */
const RARE = new Set([
  "diamond",
  "emerald",
  "ancient_debris",
  "netherite_scrap",
  "netherite_ingot",
  "diamond_ore",
  "deepslate_diamond_ore",
  "enchanted_golden_apple",
  "totem_of_undying",
  "elytra",
]);

const SEGMENT = /^[a-z0-9_-]+$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const round1 = (n: number) => Math.round(n * 10) / 10;

function event(type: string, data: Record<string, unknown>, text: string, important = false): GameEvent {
  return { type, data: { ...data, text }, important };
}

/** Maps one mod event; `null` = not forwarded (e.g. her own chat lines). */
export function mapEvent(e: BridgeEvent, opts: EventOptions = {}): GameEvent | null {
  const d = e.data;
  switch (e.name) {
    case "death": {
      const by = str(d.last_attacker) ?? str(d.last_damage_source);
      return event("death", d, by ? `死掉了(${zh(by)})` : "死掉了", true);
    }
    case "damage": {
      const amount = num(d.amount) ?? 0;
      const by = str(d.attacker) ?? str(d.source);
      const health = num(d.health);
      const text = `受傷 -${round1(amount)}${by ? `(${zh(by)})` : ""}${health === undefined ? "" : `,剩 ${round1(health)} 血`}`;
      return event("damage", d, text, amount >= (opts.damageImportant ?? 4));
    }
    case "low_health":
      return event("low_health", d, `血量很低(${round1(num(d.health) ?? 0)})`, true);
    case "hostile_near": {
      const types = Array.isArray(d.new_types) ? d.new_types.filter((t): t is string => typeof t === "string") : [];
      const important = types.some((t) => DANGEROUS.has(t));
      return event("hostile_near", d, `附近出現 ${types.map(zh).join("、") || "敵對生物"}`, important);
    }
    case "item_picked": {
      const items = (d.items as Record<string, number> | undefined) ?? {};
      const entries = Object.entries(items);
      const text = `撿到 ${entries.map(([id, n]) => `${zh(id)}×${n}`).join("、")}`;
      return event("item_picked", d, text, entries.some(([id]) => RARE.has(id)));
    }
    case "night_started":
      return event("night_started", d, "天黑了");
    case "chat": {
      if (d.self === true) return null;
      const message = str(d.message) ?? "";
      if (d.system === true) return event("chat", d, `(系統)${message}`);
      const sender = str(d.sender) ?? "某人";
      return event("chat", d, `${sender} 在遊戲裡說:${message}`, true);
    }
    case "advancement":
      return event("advancement", d, `達成成就「${str(d.title) ?? "?"}」`, true);
    case "goal_reached":
      return event("goal_reached", d, "抵達目標了");
    case "goal_failed":
      return event("goal_failed", d, "找不到路,目標失敗");
    case "baritone_idle":
      return event("baritone_idle", d, d.cancelled === true ? "Baritone 被叫停了" : "Baritone 做完了,停下來");
    default:
      return SEGMENT.test(e.name) ? { type: e.name, data: d } : null;
  }
}
