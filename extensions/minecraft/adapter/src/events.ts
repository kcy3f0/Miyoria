// Mod events (PROTOCOL.md §6) → `GameEvent`s. `data.text` is a short
// Traditional Chinese line for commentary; `important` marks what is worth
// reacting to right away.

import type { GameEvent } from "@miyoria/sdk";
import type { BridgeEvent } from "./bridge.js";
import { zh } from "./names.js";
import { normalizeChestItems } from "./waypoints.js";

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
  extinguish: "身上著火,用水桶滅火",
  mlg_water: "從高處掉落,放水落地保命",
  lava: "掉進岩漿 / 著火了,身體自己逃開",
  suffocation: "卡在方塊裡快窒息了,自己把它挖開",
  falling_block: "頭上有沙子或礫石掉下來,自己閃開",
  drowning: "快沒氣了,自己往上游",
  retreat_pillar: "被怪包圍,墊高方塊脫險",
  shield_block: "舉起盾牌擋住攻擊",
  flee: "血太少,自己逃開",
  fight: "被攻擊,自己反擊",
  eat: "肚子餓,自己吃東西",
  auto_torch: "太暗了,自己插一根火把",
  unstuck: "卡住了,自己掙脫",
  pickup: "撿起掉在地上的東西",
};
const REFLEX_END: Record<string, string> = {
  extinguish: "滅完火了",
  mlg_water: "安全落地了",
  lava: "逃出岩漿了",
  suffocation: "從方塊裡出來了",
  falling_block: "閃開了",
  drowning: "浮上來換氣了",
  retreat_pillar: "墊高脫險了",
  shield_block: "擋完攻擊了",
  flee: "逃開了",
  fight: "打完了",
  eat: "吃飽了",
  auto_torch: "插好火把了",
  unstuck: "掙脫了",
  pickup: "撿完了",
};
/** Reflexes worth an immediate reaction. */
const URGENT_REFLEX = new Set([
  "extinguish",
  "mlg_water",
  "lava",
  "suffocation",
  "falling_block",
  "drowning",
  "retreat_pillar",
  "shield_block",
  "flee",
  "fight",
]);
/** What the mod reports a reflex interrupted (a Baritone process name, `craft`, `smelt`). */
const INTERRUPTED: Record<string, string> = {
  craft: "合成",
  smelt: "熔爐",
  Mine: "挖礦",
  "Custom Goal": "走路",
  mine_branch: "分支挖礦",
  BranchMiner: "分支挖礦",
  hunt: "打獵",
  Hunter: "打獵",
  chest: "整理箱子",
  ChestWorker: "整理箱子",
  sleep: "睡覺",
  SleepWorker: "睡覺",
  clear_leaves: "清樹葉",
  LeafClearer: "清樹葉",
};

function reflexText(d: Record<string, unknown>): string {
  const kind = str(d.kind) ?? "";
  let text = REFLEX[kind] ?? `反射動作 ${kind}`;
  const what = str(d.target) ?? str(d.food);
  if (what) text += `(${zh(what)})`;
  const interrupted = str(d.interrupted);
  if (interrupted) text += `,打斷了${INTERRUPTED[interrupted] ?? interrupted}`;
  if (d.paused_task === true && d.recoverable === true) text += ",暫停等待恢復";
  return text;
}

function itemSummary(items: Record<string, number> | undefined, max = 8): string {
  if (!items) return "";
  const entries = Object.entries(items).filter(([, n]) => n > 0);
  if (!entries.length) return "空的";
  const shown = entries.slice(0, max).map(([id, n]) => `${zh(id)}×${n}`).join("、");
  return entries.length > max ? `${shown}…等 ${entries.length} 種` : shown;
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
    case "reflex_resumed": {
      const kind = str(d.reflex) ?? str(d.kind) ?? "";
      const label = REFLEX_END[kind] ?? "本能反應結束";
      return event("reflex_resumed", d, `${label},已自動恢復原本的動作`);
    }
    case "reflex_aborted": {
      const reason = str(d.reason) ?? str(d.message);
      return event("reflex_aborted", d, `本能反應後沒能恢復原本的動作${reason ? `(${reason})` : ""}`, true);
    }
    case "chest_contents": {
      const items = normalizeChestItems(d.items ?? d.contents);
      return event("chest_contents", d, `打開箱子看到:${itemSummary(items) || "空的"}`);
    }
    case "chest_finished": {
      const op = str(d.op);
      const label = op === "store" ? "存進箱子了" : op === "take" ? "從箱子拿好東西了" : "查看完箱子了";
      const items = normalizeChestItems(d.items ?? d.contents);
      return event("chest_finished", d, items ? `${label}(${itemSummary(items)})` : label);
    }
    case "chest_failed":
      return event("chest_failed", d, `箱子:${failure(d)}`, d.cancelled !== true);
    case "sleep_finished":
      return event(
        "sleep_finished",
        d,
        d.slept === false ? "點了床設好重生點(現在是白天)" : "在床上睡醒了(已設重生點)",
      );
    case "sleep_failed":
      return event("sleep_failed", d, `沒辦法睡覺:${failure(d)}`, d.cancelled !== true);
    case "hunt_finished": {
      const entity = str(d.entity);
      const count = num(d.collected) ?? num(d.killed) ?? num(d.count);
      return event("hunt_finished", d, `打獵結束${entity ? `(${zh(entity)}${count !== undefined ? `×${count}` : ""})` : ""}`);
    }
    case "hunt_failed":
      return event("hunt_failed", d, `打獵失敗:${failure(d)}`, d.cancelled !== true);
    case "branch_progress": {
      const pos = typeof d.position === "object" && d.position !== null ? (d.position as Record<string, unknown>) : undefined;
      const y = num(d.y) ?? (pos ? num(pos.y) : undefined);
      const steps = num(d.steps);
      return event(
        "branch_progress",
        d,
        `分支挖礦中${y !== undefined ? `(Y=${Math.round(y)})` : ""}${steps !== undefined ? ` 前進 ${steps} 格` : ""}`,
      );
    }
    case "branch_finished":
      return event("branch_finished", d, "分支挖礦結束");
    case "branch_failed":
      return event("branch_failed", d, `分支挖礦失敗:${failure(d)}`, d.cancelled !== true);
    case "clear_leaves_finished": {
      const cleared = num(d.cleared) ?? num(d.broken);
      return event("clear_leaves_finished", d, `清除了擋路的樹葉${cleared !== undefined ? `(${cleared} 格)` : ""}`);
    }
    case "clear_leaves_failed":
      return event("clear_leaves_failed", d, `清除樹葉失敗:${failure(d)}`);
    default:
      return SEGMENT.test(e.name) ? { type: e.name, data: d } : null;
  }
}
