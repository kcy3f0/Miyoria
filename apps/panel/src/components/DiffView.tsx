import { useMemo } from "react";
import { type DiffLine, diffLines, diffStats } from "../lib/diff";

type Chunk = { kind: "lines"; lines: DiffLine[] } | { kind: "fold"; count: number };

/** Collapses unchanged runs longer than `2 * context` lines. */
export function foldDiff(lines: DiffLine[], context = 3): Chunk[] {
  const out: Chunk[] = [];
  let buf: DiffLine[] = [];
  const flush = () => {
    if (buf.length) out.push({ kind: "lines", lines: buf });
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.op !== "same") {
      buf.push(lines[i] as DiffLine);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j]?.op === "same") j++;
    const run = lines.slice(i, j);
    const atStart = i === 0;
    const atEnd = j === lines.length;
    const keepHead = atStart ? 0 : context;
    const keepTail = atEnd ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      buf.push(...run.slice(0, keepHead));
      flush();
      out.push({ kind: "fold", count: run.length - keepHead - keepTail });
      buf.push(...run.slice(run.length - keepTail));
    } else {
      buf.push(...run);
    }
    i = j;
  }
  flush();
  return out;
}

export function DiffView({ before, after, label = "變更" }: { before: string; after: string; label?: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stats = diffStats(lines);
  const chunks = useMemo(() => foldDiff(lines), [lines]);

  if (stats.added === 0 && stats.removed === 0) {
    return <p className="muted">內容相同,沒有變更。</p>;
  }

  return (
    <div style={{ display: "grid", gap: "var(--s-2)" }}>
      <p className="field__label">
        {label}:<span style={{ color: "var(--c-ok)" }}>+{stats.added}</span>{" "}
        <span style={{ color: "var(--c-danger)" }}>−{stats.removed}</span> 行
      </p>
      <div className="diff" role="table" aria-label={label} tabIndex={0}>
        {chunks.map((c, ci) =>
          c.kind === "fold" ? (
            <div className="diff__fold" key={`f${ci}`} role="row">
              <span role="cell">⋯ {c.count} 行未變更</span>
            </div>
          ) : (
            c.lines.map((l, li) => (
              <div className="diff__line" data-op={l.op} key={`${ci}-${li}`} role="row">
                <span className="diff__no" role="cell">
                  {l.oldNo ?? ""}
                </span>
                <span className="diff__no" role="cell">
                  {l.newNo ?? ""}
                </span>
                <span className="diff__sign" role="cell" aria-label={l.op === "add" ? "新增" : l.op === "del" ? "刪除" : undefined}>
                  {l.op === "add" ? "+" : l.op === "del" ? "−" : ""}
                </span>
                <span role="cell">{l.text || " "}</span>
              </div>
            ))
          ),
        )}
      </div>
    </div>
  );
}
