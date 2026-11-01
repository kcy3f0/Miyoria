// Line diff (LCS) for the persona editor's "review before save" step.

export type DiffOp = "same" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line numbers in the old / new text. */
  oldNo?: number;
  newNo?: number;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]; flat array for speed.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] ?? "", oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
      out.push({ op: "del", text: a[i] ?? "", oldNo: i + 1 });
      i++;
    } else {
      out.push({ op: "add", text: b[j] ?? "", newNo: j + 1 });
      j++;
    }
  }
  for (; i < n; i++) out.push({ op: "del", text: a[i] ?? "", oldNo: i + 1 });
  for (; j < m; j++) out.push({ op: "add", text: b[j] ?? "", newNo: j + 1 });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "del") removed++;
  }
  return { added, removed };
}
