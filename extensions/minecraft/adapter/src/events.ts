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

/** The mod's (English) reason a craft / smelt job stopped, in Traditional Chinese where known. */
function failure(d: Record<string, unknown>): string {
  const error = str(d.error) ?? "不明原因";
  if (d.cancelled === true || error === "stopped") return "被叫停了";
  if (error === "inventory full") return "背包滿了";
  if (error.startsWith("ran out of ")) return `${zh(error.slice("ran out of ".length).replace(/\+$/, ""))}不夠了`;
  if (error.startsWith("could not open")) return "打不開(要站在旁邊、面前沒擋住)";
  if (error.startsWith("the furnace is still smelting ")) {
    return `熔爐還在燒別的(${zh(error.slice("the furnace is still smelting ".length))}),等它燒完先拿出來`;
  }
  if (error.includes("screen was closed")) return "畫面被關掉了";
  return error;
}

/** What a reflex of the mod did (`reflex` / `reflex_end` `kind`). */
const REFLEX: Record<string, string> = {
  lava: "掉進岩漿 / 著火了,身體自己逃開",
  suffocation: "卡在方塊裡快窒息了,自己把它挖開",
  falling_block: "頭上有沙子或礫石掉下來,自己閃開",
  drowning: "快沒氣了,自己往上游",
  flee: "血太少,自己逃開",
  fight: "被攻擊,自己反擊",
  eat: "肚子餓,自己吃東西",
  unstuck: "卡住了,自己掙脫",
  pickup: "撿起掉在地上的東西",
};
const REFLEX_END: Record<string, string> = {
  lava: "逃出岩漿了",
  suffocation: "從方塊裡出來了",
  falling_block: "閃開了",
  drowning: "浮上來換氣了",
  flee: "逃開了",
  fight: "打完了",
  eat: "吃飽了",
  unstuck: "掙脫了",
  pickup: "撿完了",
};
/** Reflexes worth an immediate reaction. */
const URGENT_REFLEX = new Set(["lava", "suffocation", "falling_block", "drowning", "flee", "fight"]);
/** What the mod reports a reflex interrupted (a Baritone process name, `craft`, `smelt`). */
const INTERRUPTED: Record<string, string> = { craft: "合成", smelt: "熔爐", Mine: "挖礦", "Custom Goal": "走路" };

function reflexText(d: Record<string, unknown>): string {
  const kind = str(d.kind) ?? "";
  let text = REFLEX[kind] ?? `反射動作 ${kind}`;
  const what = str(d.target) ?? str(d.food);
  if (what) text += `(${zh(what)})`;
  const interrupted = str(d.interrupted);
  if (interrupted) text += `,打斷了${INTERRUPTED[interrupted] ?? interrupted}`;
  return text;
}

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
      if (d.altoclef_done === true) return event("baritone_idle", d, "AltoClef 任務做完了,停下來");
      if (d.reason === "nothing_visible") {
        return event("baritone_idle", d, "看得到的都挖完了(附近看不到更多),停下來");
      }
      if (d.reason === "reflex") return event("baritone_idle", d, "被身體的本能反應打斷,停下來");
      return event("baritone_idle", d, d.cancelled === true ? "Baritone 被叫停了" : "Baritone 做完了,停下來");
    case "craft_finished": {
      const crafted = num(d.crafted) ?? 0;
      const requested = num(d.requested);
      const short = requested !== undefined && crafted < requested ? `(材料只夠做 ${crafted} 個)` : "";
      return event("craft_finished", d, `做好了 ${zh(str(d.item))}×${crafted}${short}`);
    }
    case "craft_failed":
      return event("craft_failed", d, `合成 ${zh(str(d.item))} 失敗:${failure(d)}`, d.cancelled !== true);
    case "smelt_finished": {
      const parts: string[] = [];
      const taken = Object.entries((d.collected as Record<string, number> | undefined) ?? {});
      if (taken.length) parts.push(`從熔爐拿出 ${taken.map(([id, n]) => `${zh(id)}×${n}`).join("、")}`);
      const count = num(d.count);
      if (str(d.item) && count) {
        const fuel = str(d.fuel) && num(d.fuel_count) ? `,燃料 ${zh(str(d.fuel))}×${num(d.fuel_count)}` : "";
        const secs = num(d.ready_in_secs);
        parts.push(`把 ${zh(str(d.item))}×${count} 放進熔爐${fuel}${secs ? `,約 ${secs} 秒後再 smelt 一次拿出來` : ""}`);
      }
      return event("smelt_finished", d, parts.length ? parts.join(";") : "熔爐裡沒有燒好的東西");
    }
    case "smelt_failed":
      return event("smelt_failed", d, `熔爐:${failure(d)}`, d.cancelled !== true);
    case "reflex": {
      // Picking up drops is routine (item_picked tells what she got).
      if (d.kind === "pickup") return null;
      return event("reflex", d, reflexText(d), URGENT_REFLEX.has(str(d.kind) ?? ""));
    }
    case "reflex_end": {
      // Only worth a new decision when it stopped something she was doing, or did not work.
      if (d.yielded === true || (!str(d.interrupted) && d.ok !== false)) return null;
      const kind = str(d.kind) ?? "";
      const text =
        d.ok === false ? `本能反應(${REFLEX[kind] ?? kind})沒有成功` : `${REFLEX_END[kind] ?? "本能反應結束了"},可以繼續了`;
      return event("reflex_end", d, text);
    }
    default:
      return SEGMENT.test(e.name) ? { type: e.name, data: d } : null;
  }
}
