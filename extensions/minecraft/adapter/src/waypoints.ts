// Persistent per-world spatial memory: waypoints (`home`, `bed`, `mine`, `last_death`,
// `table`, `furnace`, custom) and contents of chests she genuinely opened (`chest_contents` /
// `chest_finished`). Never guesses the contents of unopened chests.

import type { KnownChest } from "./planner.js";
import type { Snapshot } from "./summary.js";

export interface AdapterStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export type WaypointKind = "home" | "bed" | "mine" | "last_death" | "station" | "chest" | "custom";

export interface Waypoint {
  name: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
  kind?: WaypointKind;
  updatedAt: number;
  note?: string;
}

export interface RememberedChest {
  key: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
  items: Record<string, number>;
  updatedAt: number;
}

export interface WorldMemory {
  waypoints: Record<string, Waypoint>;
  chests: Record<string, RememberedChest>;
}

export interface MemorySummary {
  waypoints: Waypoint[];
  chests: RememberedChest[];
}

export interface WaypointStoreOptions {
  storage?: AdapterStorage;
  now?: () => number;
  keyPrefix?: string;
}

const DEFAULT_WORLD = "default";
const DEFAULT_PREFIX = "minecraft:waypoints:";
const CHEST_BLOCKS = new Set(["chest", "trapped_chest", "barrel"]);
const isBedBlock = (block: string) => block === "bed" || block.endsWith("_bed");

interface Pos {
  x: number;
  y: number;
  z: number;
}

function readPos(v: unknown): Pos | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return undefined;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return undefined;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

function distSq(a: Pos, b: Pos): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Normalizes `{ item: count }` or `[{ item, count }]` into positive integer counts. */
export function normalizeChestItems(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, number> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.item === "string" ? e.item.replace(/^minecraft:/, "") : undefined;
      const count = typeof e.count === "number" && Number.isFinite(e.count) ? Math.floor(e.count) : 0;
      if (id && count > 0) out[id] = (out[id] ?? 0) + count;
    }
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = k.replace(/^minecraft:/, "");
    const count = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
    if (id && count > 0) out[id] = count;
  }
  return out;
}

function sanitizeMemory(raw: unknown): WorldMemory {
  const mem: WorldMemory = { waypoints: {}, chests: {} };
  if (!raw || typeof raw !== "object") return mem;
  const r = raw as Record<string, unknown>;
  if (r.waypoints && typeof r.waypoints === "object" && !Array.isArray(r.waypoints)) {
    for (const [name, wp] of Object.entries(r.waypoints as Record<string, unknown>)) {
      if (!wp || typeof wp !== "object") continue;
      const w = wp as Record<string, unknown>;
      const pos = readPos(w);
      if (!pos) continue;
      mem.waypoints[name] = {
        name: typeof w.name === "string" ? w.name : name,
        ...pos,
        dimension: typeof w.dimension === "string" ? w.dimension : "overworld",
        ...(typeof w.kind === "string" ? { kind: w.kind as WaypointKind } : {}),
        updatedAt: typeof w.updatedAt === "number" ? w.updatedAt : 0,
        ...(typeof w.note === "string" ? { note: w.note } : {}),
      };
    }
  }
  if (r.chests && typeof r.chests === "object" && !Array.isArray(r.chests)) {
    for (const [key, ch] of Object.entries(r.chests as Record<string, unknown>)) {
      if (!ch || typeof ch !== "object") continue;
      const c = ch as Record<string, unknown>;
      const pos = readPos(c);
      const items = normalizeChestItems(c.items) ?? {};
      if (!pos) continue;
      mem.chests[key] = {
        key: typeof c.key === "string" ? c.key : key,
        ...pos,
        dimension: typeof c.dimension === "string" ? c.dimension : "overworld",
        items,
        updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
      };
    }
  }
  return mem;
}

export function chestKey(pos: Pos): string {
  return `chest:${Math.round(pos.x)}_${Math.round(pos.y)}_${Math.round(pos.z)}`;
}

export class WaypointStore {
  readonly #storage?: AdapterStorage;
  readonly #now: () => number;
  readonly #prefix: string;
  readonly #worlds = new Map<string, WorldMemory>();
  readonly #loading = new Map<string, Promise<WorldMemory>>();
  readonly #writes = new Map<string, Promise<void>>();
  #activeWorld = DEFAULT_WORLD;
  #lastPos: Pos | undefined;
  #lastDim = "overworld";
  #lastChestPos: Pos | undefined;
  #lastBedPos: Pos | undefined;

  constructor(opts: WaypointStoreOptions = {}) {
    this.#storage = opts.storage;
    this.#now = opts.now ?? Date.now;
    this.#prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  }

  get activeWorld(): string {
    return this.#activeWorld;
  }

  worldKey(worldId?: string): string {
    const trimmed = worldId?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : this.#activeWorld || DEFAULT_WORLD;
  }

  /** Loads per-world memory once from storage (safe under concurrent callers). */
  async ensureWorld(worldId?: string): Promise<WorldMemory> {
    const wid = this.worldKey(worldId);
    const cached = this.#worlds.get(wid);
    if (cached) return cached;
    const inflight = this.#loading.get(wid);
    if (inflight) return inflight;
    const job = (async () => {
      let mem: WorldMemory = { waypoints: {}, chests: {} };
      if (this.#storage) {
        try {
          const raw = await this.#storage.get<unknown>(`${this.#prefix}${wid}`);
          mem = sanitizeMemory(raw);
        } catch {
          // Storage read failure stays non-fatal; operate with in-memory defaults.
        }
      }
      this.#worlds.set(wid, mem);
      this.#loading.delete(wid);
      return mem;
    })();
    this.#loading.set(wid, job);
    return job;
  }

  #save(wid: string): Promise<void> {
    if (!this.#storage) return Promise.resolve();
    const mem = this.#worlds.get(wid);
    if (!mem) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(mem)) as WorldMemory;
    const prev = this.#writes.get(wid) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.#storage!.set(`${this.#prefix}${wid}`, snapshot))
      .catch(() => undefined);
    this.#writes.set(wid, next);
    return next;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#writes.values()]);
  }

  /** Saves or updates a named waypoint. */
  async set(
    name: string,
    wp: { x: number; y: number; z: number; dimension?: string; kind?: WaypointKind; note?: string },
    worldId?: string,
  ): Promise<Waypoint> {
    const wid = this.worldKey(worldId);
    const mem = await this.ensureWorld(wid);
    const clean = name.trim();
    const entry: Waypoint = {
      name: clean,
      x: Math.round(wp.x),
      y: Math.round(wp.y),
      z: Math.round(wp.z),
      dimension: wp.dimension ?? this.#lastDim ?? "overworld",
      kind: wp.kind ?? "custom",
      updatedAt: this.#now(),
      ...(wp.note ? { note: wp.note } : {}),
    };
    mem.waypoints[clean] = entry;
    await this.#save(wid);
    return entry;
  }

  async get(name: string, worldId?: string): Promise<Waypoint | undefined> {
    const wid = this.worldKey(worldId);
    const mem = await this.ensureWorld(wid);
    return mem.waypoints[name.trim()];
  }

  getSync(name: string, worldId?: string): Waypoint | undefined {
    const wid = this.worldKey(worldId);
    return this.#worlds.get(wid)?.waypoints[name.trim()];
  }

  async delete(name: string, worldId?: string): Promise<boolean> {
    const wid = this.worldKey(worldId);
    const mem = await this.ensureWorld(wid);
    const clean = name.trim();
    if (!(clean in mem.waypoints)) return false;
    delete mem.waypoints[clean];
    if (clean in mem.chests) delete mem.chests[clean];
    await this.#save(wid);
    return true;
  }

  async list(worldId?: string): Promise<MemorySummary> {
    const wid = this.worldKey(worldId);
    const mem = await this.ensureWorld(wid);
    return {
      waypoints: Object.values(mem.waypoints).sort((a, b) => a.name.localeCompare(b.name)),
      chests: Object.values(mem.chests).sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }

  summarySync(worldId?: string): MemorySummary | undefined {
    const wid = this.worldKey(worldId);
    const mem = this.#worlds.get(wid);
    if (!mem) return undefined;
    const waypoints = Object.values(mem.waypoints).sort((a, b) => a.name.localeCompare(b.name));
    const chests = Object.values(mem.chests).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!waypoints.length && !chests.length) return undefined;
    return { waypoints, chests };
  }

  /** Remembered opened chests in `dimension` within `maxDist` blocks that still hold items. */
  nearbyChests(dimension: string, pos?: Pos, maxDist = 96, worldId?: string): KnownChest[] {
    const wid = this.worldKey(worldId);
    const mem = this.#worlds.get(wid);
    if (!mem) return [];
    const maxSq = maxDist * maxDist;
    const out: KnownChest[] = [];
    for (const c of Object.values(mem.chests)) {
      if (c.dimension !== dimension) continue;
      const hasItems = Object.values(c.items).some((n) => n > 0);
      if (!hasItems) continue;
      if (pos) {
        const d2 = distSq(pos, c);
        if (d2 > maxSq) continue;
        out.push({ key: c.key, x: c.x, y: c.y, z: c.z, items: { ...c.items }, distance: Math.sqrt(d2) });
      } else {
        out.push({ key: c.key, x: c.x, y: c.y, z: c.z, items: { ...c.items } });
      }
    }
    out.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    return out;
  }

  /** Updates auto-waypoints from an `observe` snapshot (never guesses chest contents). */
  async observeSnapshot(snap: Snapshot): Promise<void> {
    if (snap.world_id?.trim()) this.#activeWorld = snap.world_id.trim();
    const wid = this.worldKey(snap.world_id);
    const mem = await this.ensureWorld(wid);
    const pos = readPos(snap.block_position ?? snap.position);
    const dim = snap.dimension ?? this.#lastDim ?? "overworld";
    if (pos) this.#lastPos = pos;
    this.#lastDim = dim;

    let dirty = false;
    const now = this.#now();

    if (pos && dim === "overworld" && !mem.waypoints.home) {
      mem.waypoints.home = { name: "home", ...pos, dimension: dim, kind: "home", updatedAt: now };
      dirty = true;
    }

    const blocks = snap.nearby_blocks ?? [];
    this.#lastChestPos = undefined;
    this.#lastBedPos = undefined;
    for (const b of blocks) {
      const nearest = readPos(b.nearest);
      if (!nearest) continue;
      if (b.block === "crafting_table" && !mem.waypoints.table) {
        mem.waypoints.table = { name: "table", ...nearest, dimension: dim, kind: "station", updatedAt: now };
        dirty = true;
      } else if (
        (b.block === "furnace" || b.block === "blast_furnace" || b.block === "smoker") &&
        !mem.waypoints.furnace
      ) {
        mem.waypoints.furnace = { name: "furnace", ...nearest, dimension: dim, kind: "station", updatedAt: now };
        dirty = true;
      } else if (isBedBlock(b.block)) {
        if (!this.#lastBedPos) this.#lastBedPos = nearest;
        if (!mem.waypoints.bed) {
          mem.waypoints.bed = { name: "bed", ...nearest, dimension: dim, kind: "bed", updatedAt: now };
          dirty = true;
        }
      } else if (CHEST_BLOCKS.has(b.block) && !this.#lastChestPos) {
        this.#lastChestPos = nearest;
      }
    }

    if (dirty) await this.#save(wid);
  }

  /** Records a placed station (`crafting_table` / `furnace`) or `mine` entrance. */
  async recordStation(station: "crafting_table" | "furnace", pos?: Pos, dimension?: string): Promise<void> {
    const p = pos ?? this.#lastPos;
    if (!p) return;
    const name = station === "crafting_table" ? "table" : "furnace";
    await this.set(name, { ...p, dimension: dimension ?? this.#lastDim, kind: "station" });
  }

  async recordMineEntrance(pos?: Pos, dimension?: string): Promise<void> {
    const p = pos ?? this.#lastPos;
    if (!p) return;
    const wid = this.worldKey();
    const mem = await this.ensureWorld(wid);
    const existing = mem.waypoints.mine;
    // Update `mine` when none is set or when starting a new surface/upper mine far away.
    if (!existing || (p.y >= 40 && distSq(existing, p) > 32 * 32)) {
      await this.set("mine", { ...p, dimension: dimension ?? this.#lastDim, kind: "mine" }, wid);
    }
  }

  /** Records `last_death` from a `death` event. */
  async recordDeath(data: Record<string, unknown>, worldId?: string): Promise<Waypoint | undefined> {
    const pos = readPos(data.position) ?? this.#lastPos;
    if (!pos) return undefined;
    const dim = typeof data.dimension === "string" ? data.dimension : this.#lastDim;
    return this.set("last_death", { ...pos, dimension: dim, kind: "last_death" }, worldId);
  }

  /** Records `bed` when a `sleep_finished` event arrives. */
  async recordSleep(data: Record<string, unknown>, worldId?: string): Promise<void> {
    const pos = readPos(data.position) ?? readPos(data.bed) ?? this.#lastBedPos ?? this.#lastPos;
    if (!pos) return;
    const dim = typeof data.dimension === "string" ? data.dimension : this.#lastDim;
    await this.set("bed", { ...pos, dimension: dim, kind: "bed" }, worldId);
  }

  /** Updates opened-chest contents from `chest_contents` or `chest_finished` (never guessed). */
  async recordChestEvent(
    eventName: "chest_contents" | "chest_finished",
    data: Record<string, unknown>,
    worldId?: string,
  ): Promise<RememberedChest | undefined> {
    const pos = readPos(data.position) ?? this.#lastChestPos ?? this.#lastPos;
    if (!pos) return undefined;
    const wid = this.worldKey(worldId);
    const mem = await this.ensureWorld(wid);
    const dim = typeof data.dimension === "string" ? data.dimension : this.#lastDim;
    const key = chestKey(pos);
    const now = this.#now();

    const fullItems = normalizeChestItems(data.items ?? data.contents);
    let nextItems: Record<string, number> | undefined;
    if (fullItems !== undefined) {
      nextItems = fullItems;
    } else if (eventName === "chest_finished") {
      const prev = mem.chests[key]?.items ? { ...mem.chests[key].items } : undefined;
      const stored = normalizeChestItems(data.stored);
      const taken = normalizeChestItems(data.taken);
      if (stored || taken) {
        const merged = prev ?? {};
        for (const [id, n] of Object.entries(stored ?? {})) merged[id] = (merged[id] ?? 0) + n;
        for (const [id, n] of Object.entries(taken ?? {})) {
          const left = (merged[id] ?? 0) - n;
          if (left > 0) merged[id] = left;
          else delete merged[id];
        }
        nextItems = merged;
      }
    }

    if (nextItems === undefined) return undefined;
    const entry: RememberedChest = {
      key,
      ...pos,
      dimension: dim,
      items: nextItems,
      updatedAt: now,
    };
    mem.chests[key] = entry;
    mem.waypoints[key] = { name: key, ...pos, dimension: dim, kind: "chest", updatedAt: now };
    await this.#save(wid);
    return entry;
  }
}
