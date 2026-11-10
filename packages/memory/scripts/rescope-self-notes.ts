// One-off: moves her old `global` notes that are about someone else into the server they were
// written in. Until 2026-11-11 every note of hers written in a server was `global`, so a note about
// someone there (「我懷疑木呱是機器人」, a card someone posted) could come back in anyone's DM. New
// notes are scoped by `scopeForNew`; this moves the old ones by the same test (`aboutOthers`).
//
// SQLite only. Stop the node first (it holds the database), and back it up (scripts/backup.*).
//
//   pnpm --filter @miyoria/memory rescope-self-notes -- --db data/miyoria.db            (dry run)
//   pnpm --filter @miyoria/memory rescope-self-notes -- --db data/miyoria.db --apply
//
// Options: `--scope guild|channel` (default `guild`, like `memory.guild_scope`), `--samples N`
// (rows printed per group, default 8), `--profile ID` (default: every profile).
//
// A dry run opens the database read-only and changes nothing. A note whose source is not a server
// place (none recorded, or a DM) cannot be placed: it is left as it is and counted.

import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { aboutOthers, refersToOthers } from "../src/scope.js";

interface Row {
  id: string;
  profile_id: string;
  subjects: string;
  content: string;
  source_context: string | null;
}

interface Context {
  platform: string;
  scope: string | null;
  channel: string;
  kind: string;
}

type Why = "tagged" | "named" | "referred";

const GLOBAL_KEY = JSON.stringify({ type: "global" });

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      apply: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      scope: { type: "string", default: "guild" },
      samples: { type: "string", default: "8" },
      profile: { type: "string" },
    },
  });
  const path = values.db;
  if (path === undefined || path === "") fail("--db <path to the SQLite file> is required");
  if (values.apply && values["dry-run"]) fail("--apply and --dry-run exclude each other");
  if (values.scope !== "guild" && values.scope !== "channel") fail("--scope is guild or channel");
  const samples = Number.parseInt(values.samples ?? "8", 10);
  const apply = values.apply === true;

  const db = new DatabaseSync(path, { readOnly: !apply });
  const names = knownNames(db);
  const rows = db
    .prepare(
      "SELECT id, profile_id, subjects, content, source_context FROM memory_records " +
        "WHERE kind = 'self_note' AND scope_key = ? AND superseded_by IS NULL " +
        (values.profile !== undefined ? "AND profile_id = ? " : "") +
        "ORDER BY created_at",
    )
    .all(
      ...(values.profile !== undefined ? [GLOBAL_KEY, values.profile] : [GLOBAL_KEY]),
    ) as unknown[] as Row[];

  const stay: Row[] = [];
  const unplaced: Row[] = [];
  const moves: { row: Row; scope: string; why: Why }[] = [];
  for (const row of rows) {
    const subjects = JSON.parse(row.subjects) as string[];
    if (!aboutOthers(row.content, subjects, names)) {
      stay.push(row);
      continue;
    }
    const why: Why =
      subjects.length > 0 ? "tagged" : refersToOthers(row.content) ? "referred" : "named";
    const scope = target(row.source_context, values.scope);
    if (scope === null) unplaced.push(row);
    else moves.push({ row, scope, why });
  }

  const by = (why: Why) => moves.filter((m) => m.why === why);
  const places = new Map<string, number>();
  for (const m of moves) places.set(m.scope, (places.get(m.scope) ?? 0) + 1);

  console.log(`${apply ? "APPLY" : "DRY RUN"} on ${path}`);
  console.log(`known names: ${names.length}`);
  console.log(`global self notes: ${rows.length}`);
  console.log(`  about her alone, stay global: ${stay.length}`);
  console.log(`  about someone else, to move: ${moves.length}`);
  console.log(`    tagged with someone: ${by("tagged").length}`);
  console.log(`    naming someone (untagged): ${by("named").length}`);
  console.log(`    referring to someone (對方/有人/大家/他…, untagged): ${by("referred").length}`);
  console.log(`  about someone else, no server to move to (left as is): ${unplaced.length}`);
  console.log("  moved to:");
  for (const [scope, n] of places) console.log(`    ${scope}: ${n}`);

  const show = (title: string, list: readonly Row[]) => {
    console.log(`\n${title} (${list.length}, first ${Math.min(samples, list.length)}):`);
    for (const r of list.slice(0, samples)) console.log(`  ${r.id}  ${r.subjects}  ${r.content}`);
  };
  show(
    "move, tagged",
    by("tagged").map((m) => m.row),
  );
  show(
    "move, named",
    by("named").map((m) => m.row),
  );
  show(
    "move, referred",
    by("referred").map((m) => m.row),
  );
  show("stay global", stay);
  show("left as is (no server)", unplaced);

  if (!apply) {
    console.log(
      "\nNothing was changed. Run again with --apply (node stopped, database backed up).",
    );
    db.close();
    return;
  }
  const update = db.prepare("UPDATE memory_records SET scope = ?, scope_key = ? WHERE id = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const m of moves) update.run(m.scope, m.scope, m.row.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(`\nMoved ${moves.length} notes.`);
  db.close();
}

/** Every name she knows people by: handles, people and their accounts. */
function knownNames(db: DatabaseSync): string[] {
  const out = new Set<string>();
  const handles = db
    .prepare("SELECT value FROM profile_settings WHERE key LIKE 'handle:%'")
    .all() as { value: string }[];
  for (const { value } of handles) {
    const entry = JSON.parse(value) as { handle?: unknown };
    if (typeof entry.handle === "string") out.add(entry.handle);
  }
  for (const table of ["people", "accounts"]) {
    const rows = db.prepare(`SELECT display_name FROM ${table}`).all() as {
      display_name: string;
    }[];
    for (const { display_name } of rows) out.add(display_name);
  }
  return [...out].filter((n) => n.trim() !== "");
}

/** The stored scope (canonical, as `memoryScopeKey` writes it) of the server a note came from. */
function target(source: string | null, kind: string | undefined): string | null {
  if (source === null) return null;
  const c = JSON.parse(source) as Context;
  if (c.scope === null || c.scope === undefined || c.kind === "dm") return null;
  if (kind === "channel") {
    const context = { platform: c.platform, scope: c.scope, channel: c.channel, kind: c.kind };
    return JSON.stringify({ type: "channel", context });
  }
  return JSON.stringify({ type: "guild", platform: c.platform, guild: c.scope });
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

main();
