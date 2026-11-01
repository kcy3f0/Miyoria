// High-level actions offered to the model and their mapping onto the mod's
// requests (PROTOCOL.md §5). Actions only *start* work; completion arrives as
// events (`goal_reached`, `baritone_idle`, ...) or shows in `observe`.

import type { GameAction, GameActionSpec, JsonSchema } from "@miyoria/sdk";

const int = (description: string): JsonSchema => ({ type: "integer", description });
const str = (description: string): JsonSchema => ({ type: "string", description });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
});
const xyz = obj({ x: int("x"), y: int("y"), z: int("z") }, ["x", "y", "z"]);

export const ACTIONS: GameActionSpec[] = [
  {
    name: "goto",
    description: "用 Baritone 走到座標({x,y,z} 或只給 {x,z}),或走到最近的某種方塊旁({block})",
    parameters: obj({
      x: int("x"),
      y: int("y(可省略)"),
      z: int("z"),
      block: str("方塊 id,例如 crafting_table"),
      near: int("走到離座標幾格內就好"),
    }),
  },
  {
    name: "mine",
    description: "用 Baritone 蒐集 / 挖某些方塊,count 省略 = 一直挖到 stop",
    parameters: obj({
      blocks: { type: "array", items: { type: "string" }, description: "方塊 id,例如 [\"iron_ore\",\"deepslate_iron_ore\"]" },
      block: str("單一方塊 id"),
      count: int("要幾個"),
    }),
  },
  {
    name: "follow",
    description: "跟著某個玩家({player})或某種生物({entity})走",
    parameters: obj({ player: str("玩家名稱"), entity: str("生物 id") }),
  },
  {
    name: "explore",
    description: "以某點(預設目前位置)為中心探索沒去過的地方",
    parameters: obj({ x: int("x"), z: int("z") }),
  },
  {
    name: "farm",
    description: "自動收割並重新種植附近的作物",
    parameters: obj({ range: int("範圍(格),0 = 預設") }),
  },
  {
    name: "build",
    description: "用 Baritone 照藍圖蓋建築(baritone/schematics 裡的檔名)",
    parameters: obj({ schematic: str("藍圖檔名"), x: int("x"), y: int("y"), z: int("z") }, ["schematic"]),
  },
  {
    name: "get",
    description: "用 AltoClef 取得物品(自動砍樹、挖礦、合成…),例如 {item:\"iron_pickaxe\"}",
    parameters: obj({ item: str("物品 id"), count: int("數量,預設 1") }, ["item"]),
  },
  {
    name: "chat",
    description: "在遊戲聊天室說一句話",
    parameters: obj({ message: str("要說的話(256 字以內)") }, ["message"]),
  },
  { name: "stop", description: "停下所有動作(Baritone、AltoClef、按住的按鍵)", parameters: obj({}) },
  {
    name: "look",
    description: "轉頭:{yaw,pitch}(度)或看向座標 {at:{x,y,z}}",
    parameters: obj({ yaw: { type: "number" }, pitch: { type: "number" }, at: xyz }),
  },
  {
    name: "attack",
    description: "左鍵(攻擊 / 挖準心指到的東西);hold_ticks 按住多久(20 = 1 秒)",
    parameters: obj({ hold_ticks: int("1–1200") }),
  },
  {
    name: "use",
    description: "右鍵(吃東西、放方塊、開門…);吃東西約 hold_ticks 32",
    parameters: obj({ hold_ticks: int("1–1200") }),
  },
  { name: "select", description: "切換快捷列:{slot:0-8} 或 {item}", parameters: obj({ slot: int("0–8"), item: str("物品 id") }) },
  { name: "respawn", description: "死掉時按重生", parameters: obj({}) },
];

/** One request to send to the mod (`type` plus parameters). */
export interface BridgeRequest {
  type: string;
  params: Record<string, unknown>;
}

export interface MapOptions {
  allowCommands?: boolean;
}

/** Thrown for arguments the model got wrong; the message goes back to it. */
export class ActionError extends Error {}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const id = (v: unknown): string | undefined => text(v)?.toLowerCase().replace(/\s+/g, "_");

function baritone(command: string, params: Record<string, unknown> = {}): BridgeRequest {
  return { type: "baritone", params: { command, ...params } };
}

function hold(args: Record<string, unknown>): Record<string, unknown> {
  const ticks = num(args.hold_ticks);
  if (ticks === undefined) return {};
  return { hold_ticks: Math.min(1200, Math.max(1, Math.round(ticks))) };
}

/** Maps an action onto mod requests; throws `ActionError` for bad arguments. */
export function toRequests(action: GameAction, opts: MapOptions = {}): BridgeRequest[] {
  const a = action.args ?? {};
  switch (action.name) {
    case "goto": {
      const x = num(a.x);
      const y = num(a.y);
      const z = num(a.z);
      const near = num(a.near);
      if (x !== undefined && z !== undefined) {
        return [baritone("goto", { x: Math.round(x), ...(y === undefined ? {} : { y: Math.round(y) }), z: Math.round(z), ...(near === undefined ? {} : { near }) })];
      }
      const block = id(a.block);
      if (block) return [baritone("goto", { block })];
      throw new ActionError("goto 要給 {x,z}、{x,y,z} 或 {block}");
    }
    case "mine": {
      const list = Array.isArray(a.blocks) ? a.blocks.map(id).filter((b): b is string => !!b) : [];
      const single = id(a.block);
      if (single) list.push(single);
      if (!list.length) throw new ActionError("mine 要給 blocks(方塊 id 陣列)或 block");
      const count = num(a.count);
      return [baritone("mine", { blocks: [...new Set(list)], ...(count ? { count: Math.max(0, Math.round(count)) } : {}) })];
    }
    case "follow": {
      const player = text(a.player);
      if (player) return [baritone("follow", { player })];
      const entity = id(a.entity);
      if (entity) return [baritone("follow", { entity })];
      throw new ActionError("follow 要給 player 或 entity");
    }
    case "explore": {
      const x = num(a.x);
      const z = num(a.z);
      return [baritone("explore", x !== undefined && z !== undefined ? { x: Math.round(x), z: Math.round(z) } : {})];
    }
    case "farm": {
      const range = num(a.range);
      return [baritone("farm", range === undefined ? {} : { range: Math.max(0, Math.round(range)) })];
    }
    case "build": {
      const schematic = text(a.schematic);
      if (!schematic) throw new ActionError("build 要給 schematic(藍圖檔名)");
      const origin: Record<string, number> = {};
      for (const k of ["x", "y", "z"] as const) {
        const v = num(a[k]);
        if (v !== undefined) origin[k] = Math.round(v);
      }
      return [baritone("build", { schematic, ...(Object.keys(origin).length === 3 ? origin : {}) })];
    }
    case "get": {
      const item = id(a.item);
      if (!item || !/^[a-z0-9_:]+$/.test(item)) throw new ActionError("get 要給 item(物品 id)");
      const count = Math.max(1, Math.round(num(a.count) ?? 1));
      return [{ type: "altoclef", params: { command: `get ${item} ${count}` } }];
    }
    case "chat": {
      const message = text(a.message);
      if (!message) throw new ActionError("chat 要給 message");
      if (!opts.allowCommands && /^[/@#]/.test(message)) {
        throw new ActionError("chat 不能下指令(/、@、# 開頭)");
      }
      return [{ type: "chat", params: { message: [...message].slice(0, 256).join("") } }];
    }
    case "stop":
      return [{ type: "stop", params: {} }];
    case "look": {
      const at = a.at as Record<string, unknown> | undefined;
      if (at && typeof at === "object") {
        const [x, y, z] = [num(at.x), num(at.y), num(at.z)];
        if (x === undefined || y === undefined || z === undefined) throw new ActionError("look.at 要有 x,y,z");
        return [{ type: "look", params: { at: { x, y, z } } }];
      }
      const yaw = num(a.yaw);
      const pitch = num(a.pitch);
      if (yaw === undefined && pitch === undefined) throw new ActionError("look 要給 yaw / pitch 或 at");
      return [
        {
          type: "look",
          params: {
            ...(yaw === undefined ? {} : { yaw }),
            ...(pitch === undefined ? {} : { pitch: Math.min(90, Math.max(-90, pitch)) }),
          },
        },
      ];
    }
    case "attack":
      return [{ type: "attack", params: hold(a) }];
    case "use":
      return [{ type: "use", params: hold(a) }];
    case "select": {
      const slot = num(a.slot);
      if (slot !== undefined) {
        if (slot < 0 || slot > 8) throw new ActionError("slot 要是 0–8");
        return [{ type: "select_slot", params: { slot: Math.round(slot) } }];
      }
      const item = id(a.item);
      if (item) return [{ type: "select_slot", params: { item } }];
      throw new ActionError("select 要給 slot 或 item");
    }
    case "respawn":
      return [{ type: "respawn", params: {} }];
    default:
      throw new ActionError(`沒有「${action.name}」這個動作`);
  }
}

/** Short Traditional Chinese line describing what was started. */
export function describeAction(action: GameAction): string {
  const a = action.args ?? {};
  switch (action.name) {
    case "goto":
      return a.block ? `走向 ${a.block}` : `走到 (${a.x}, ${a.y ?? "~"}, ${a.z})`;
    case "mine":
      return `開始挖 ${[...(Array.isArray(a.blocks) ? a.blocks : []), ...(a.block ? [a.block] : [])].join("、")}${a.count ? ` ×${a.count}` : ""}`;
    case "follow":
      return `跟著 ${a.player ?? a.entity}`;
    case "explore":
      return "開始探索";
    case "farm":
      return "開始種田";
    case "build":
      return `開始蓋 ${a.schematic}`;
    case "get":
      return `用 AltoClef 取得 ${a.item}${a.count ? ` ×${a.count}` : ""}`;
    case "chat":
      return `說了:${a.message}`;
    case "stop":
      return "停下來了";
    default:
      return `做了 ${action.name}`;
  }
}

/** Mod error code → message for the model. */
export function errorText(code: string, message: string): string {
  switch (code) {
    case "not_connected":
      return "沒有連上 Minecraft(遊戲沒開,或 miyoria-bridge 模組沒載入)";
    case "not_in_game":
      return "還在主選單或載入中,不在遊戲世界裡";
    case "baritone_unavailable":
      return "沒有安裝 Baritone,不能自動走路 / 挖礦";
    case "altoclef_unavailable":
      return "沒有安裝 AltoClef(或還沒初始化),不能用 get";
    case "invalid_args":
      return `參數不對:${message}`;
    case "timeout":
      return "模組沒有回應(逾時)";
    default:
      return `${code}:${message}`;
  }
}
