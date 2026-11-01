// `${VAR}` / `${VAR:-default}` references in `miyoria.toml` strings, and masking of secrets.

import { isEnvName } from "./env-file.js";

export interface EnvRef {
  name: string;
  default: string | null;
}

function splitRef(expr: string): EnvRef {
  const sep = expr.indexOf(":-");
  return sep === -1
    ? { name: expr, default: null }
    : { name: expr.slice(0, sep), default: expr.slice(sep + 2) };
}

/** All `${...}` references in a string. */
export function envRefs(s: string): EnvRef[] {
  const out: EnvRef[] = [];
  let rest = s;
  for (let start = rest.indexOf("${"); start !== -1; start = rest.indexOf("${")) {
    const after = rest.slice(start + 2);
    const end = after.indexOf("}");
    if (end === -1) break;
    out.push(splitRef(after.slice(0, end)));
    rest = after.slice(end + 1);
  }
  return out;
}

/** The reference when the whole string is exactly one `${VAR}` / `${VAR:-default}`. */
export function singleRef(s: string): EnvRef | null {
  if (!s.startsWith("${") || !s.endsWith("}")) return null;
  const inner = s.slice(2, -1);
  if (inner.includes("}") || inner.includes("${")) return null;
  const r = splitRef(inner);
  return isEnvName(r.name) ? r : null;
}

/** Where an effective value came from. */
export type Source = "dotenv" | "process" | "default" | "unset";

export function sourceLabel(source: Source): string {
  switch (source) {
    case "dotenv":
      return ".env";
    case "process":
      return "環境變數";
    case "default":
      return "預設值";
    case "unset":
      return "未設定";
  }
}

export type Lookup = (name: string) => [string, Source] | undefined;

/** Expands references like the kernel does, reporting each variable's source. */
export function expand(s: string, lookup: Lookup): [string, Array<[string, Source]>] {
  let out = "";
  const used: Array<[string, Source]> = [];
  let rest = s;
  for (let start = rest.indexOf("${"); start !== -1; start = rest.indexOf("${")) {
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf("}");
    if (end === -1) return [out + rest.slice(start), used];
    const r = splitRef(after.slice(0, end));
    const found = lookup(r.name);
    if (found && found[0] !== "") {
      out += found[0];
      used.push([r.name, found[1]]);
    } else if (r.default !== null) {
      out += r.default;
      used.push([r.name, "default"]);
    } else if (found) {
      out += found[0];
      used.push([r.name, found[1]]);
    } else {
      used.push([r.name, "unset"]);
    }
    rest = after.slice(end + 1);
  }
  return [out + rest, used];
}

// ---- secrets -----------------------------------------------------------------------------

/** Key or variable names whose values must not be printed. */
export function isSecret(name: string): boolean {
  const n = name.toLowerCase();
  return ["token", "secret", "password", "passwd", "api_key", "apikey"].some((w) => n.includes(w));
}

/** `••••` plus the last four characters of long values. */
export function mask(value: string): string {
  const chars = [...value];
  if (chars.length === 0) return "(空)";
  if (chars.length <= 8) return "••••";
  return `••••${chars.slice(-4).join("")}`;
}

/** Hides the password of `scheme://user:password@host` URLs. */
export function maskUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.password === "") return value;
  url.password = "****";
  return url.toString();
}

/** How to print `value` of key / variable `name`. */
export function display(name: string, value: string, reveal: boolean): string {
  if (reveal) return value;
  return isSecret(name) ? mask(value) : maskUrl(value);
}
