// Shared parts of the whole-profile export / wipe: which columns of which tables a backup
// contains, and how a backend's raw values become plain JSON.

import type { JsonObject, JsonValue } from "@miyoria/types";
import { fromMicros, normalizeTimestamp } from "./common.js";
import type { WipeCounts, WipePlan } from "./stores.js";

export type ExportColumn = "text" | "num" | "bool" | "ts" | "json";

export interface ExportTable {
  table: string;
  order: string;
  columns: Readonly<Record<string, ExportColumn>>;
}

/** The tables of a profile backup, by `ProfileExport` field. Embeddings are left out. */
export const EXPORT_TABLES = {
  memories: {
    table: "memory_records",
    order: "created_at, id",
    columns: {
      id: "text",
      kind: "text",
      scope: "json",
      subjects: "json",
      content: "text",
      importance: "num",
      confidence: "num",
      created_at: "ts",
      updated_at: "ts",
      last_accessed: "ts",
      access_count: "num",
      source_context: "json",
      due: "ts",
      done: "bool",
      superseded_by: "text",
    },
  },
  relationships: {
    table: "relationships",
    order: "person_id",
    columns: {
      person_id: "text",
      affinity: "num",
      trust: "num",
      familiarity: "num",
      tags: "json",
      notes: "text",
      call_name: "text",
      interactions: "num",
      last_interaction: "ts",
      updated_at: "ts",
    },
  },
  relationship_deltas: {
    table: "relationship_deltas",
    order: "seq",
    columns: {
      person_id: "text",
      at: "ts",
      affinity: "num",
      trust: "num",
      familiarity: "num",
      reason: "text",
    },
  },
  messages: {
    table: "message_log",
    order: "seq",
    columns: {
      id: "text",
      platform: "text",
      scope: "text",
      channel: "text",
      kind: "text",
      author_platform: "text",
      author_id: "text",
      author_name: "text",
      text: "text",
      is_self: "bool",
      ts: "ts",
      turn_id: "text",
    },
  },
  decisions: {
    table: "decision_log",
    order: "ts, id",
    columns: { id: "text", ts: "ts", trace: "json" },
  },
} as const satisfies Record<string, ExportTable>;

export type ExportField = keyof typeof EXPORT_TABLES;

/** Which tables a plan includes. */
export function planTables(plan: WipePlan): ExportField[] {
  const out: ExportField[] = [];
  if (plan.memories) out.push("memories");
  if (plan.relationships) out.push("relationships", "relationship_deltas");
  if (plan.messages) out.push("messages");
  if (plan.decisions) out.push("decisions");
  return out;
}

export function emptyCounts(): WipeCounts {
  return {
    memories: 0,
    relationships: 0,
    relationship_deltas: 0,
    messages: 0,
    decisions: 0,
    settings: 0,
  };
}

function value(kind: ExportColumn, raw: unknown): JsonValue {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case "text":
      return String(raw);
    case "num":
      return Number(raw);
    case "bool":
      return typeof raw === "boolean" ? raw : Number(raw) !== 0;
    case "ts":
      if (typeof raw === "number" || typeof raw === "bigint") return fromMicros(Number(raw));
      if (raw instanceof Date) return raw.toISOString();
      return normalizeTimestamp(String(raw));
    case "json":
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw) as JsonValue;
        } catch {
          return raw;
        }
      }
      return JSON.parse(JSON.stringify(raw)) as JsonValue;
  }
}

/** A raw row as plain JSON, with only the exported columns. */
export function exportRow(spec: ExportTable, row: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [column, kind] of Object.entries(spec.columns)) out[column] = value(kind, row[column]);
  return out;
}

/** `SELECT` list of a table's exported columns. */
export function exportColumns(spec: ExportTable): string {
  return Object.keys(spec.columns).join(", ");
}

/** Whether a settings key is removed by a plan. */
export function planCoversKey(plan: WipePlan, key: string): boolean {
  return plan.settings_keys.includes(key) || plan.settings_prefixes.some((p) => key.startsWith(p));
}
