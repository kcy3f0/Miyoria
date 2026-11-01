// Input validation for config values. Errors are user-facing (zh-TW). Strings holding `${VAR}`
// references are not checked; their value is.

import { isEnvName } from "./env-file.js";
import { isTable, type TomlValue } from "./toml-patch.js";

/** `null` when valid, else the error text. */
export type Check = (s: string) => string | null;

function urlWith(s: string, schemes: readonly string[], hint: string): string | null {
  const t = s.trim();
  if (t.includes("${")) return null;
  try {
    const u = new URL(t);
    const scheme = u.protocol.replace(/:$/, "");
    return schemes.includes(scheme) && u.hostname !== "" ? null : hint;
  } catch {
    return hint;
  }
}

export const httpUrl: Check = (s) =>
  urlWith(s, ["http", "https"], "要是 http:// 或 https:// 開頭的網址,例如 http://127.0.0.1:8001");

export const wsUrl: Check = (s) =>
  urlWith(
    s,
    ["ws", "wss", "http", "https"],
    "要是 ws:// 或 wss:// 開頭的網址,例如 ws://127.0.0.1:7882/stage-link",
  );

export const databaseUrl: Check = (s) => {
  const t = s.trim();
  if (t === "memory://" || t.includes("${")) return null;
  if (t.startsWith("sqlite:")) {
    return t.replace(/^sqlite:(\/\/)?/, "") === ""
      ? "SQLite 要有檔案路徑,例如 sqlite:data/miyoria.db"
      : null;
  }
  return urlWith(
    t,
    ["postgres", "postgresql"],
    "要是 sqlite:data/miyoria.db、memory:// 或 postgres://使用者:密碼@主機:5432/資料庫",
  );
};

export const port: Check = (s) => {
  const t = s.trim();
  const n = /^\d+$/.test(t) ? Number(t) : Number.NaN;
  return n >= 1 && n <= 65535 ? null : "port 要是 1–65535 的整數";
};

export const bind: Check = (s) => {
  const t = s.trim();
  if (t.includes("${")) return null;
  const hint = "格式是 主機:port,例如 127.0.0.1:7878";
  const colon = t.lastIndexOf(":");
  if (colon <= 0) return hint;
  const host = t.slice(0, colon);
  if (/\s/.test(host)) return hint;
  return port(t.slice(colon + 1)) === null ? null : hint;
};

export const discordId: Check = (s) => {
  const t = s.trim();
  return /^\d{17,20}$/.test(t) ? null : "Discord id 是 17–20 位數字(開發者模式 → 右鍵 → 複製 ID)";
};

export const optionalDiscordId: Check = (s) => (s.trim() === "" ? null : discordId(s));

/** Comma or space separated ids; empty is fine. */
export const discordIds: Check = (s) => {
  for (const part of s.split(/[, ]/)) {
    if (part.trim() === "") continue;
    const err = discordId(part);
    if (err) return err;
  }
  return null;
};

export const modelId: Check = (s) => {
  const t = s.trim();
  if (t === "") return "模型 id 不能是空的";
  if (/\s/.test(t)) return "模型 id 不能有空白";
  return null;
};

export const envName: Check = (s) =>
  isEnvName(s) ? null : `\`${s}\` 不是合法的環境變數名稱(英數字和底線,例如 LLM_API_KEY)`;

/** Checks a value written with `miyoria config set` by its key name. */
export function valueForKey(path: readonly string[], value: TomlValue): string | null {
  const last = path.at(-1) ?? "";
  if (typeof value === "string" && value.includes("${")) return null;
  const string = (check: Check) =>
    typeof value === "string" ? check(value) : `\`${last}\` 要是字串`;
  if ((last === "enabled" || last === "dev") && typeof value !== "boolean") {
    return `\`${last}\` 要是 true 或 false`;
  }
  if (last === "port") {
    return typeof value === "bigint" && value >= 1n && value <= 65535n
      ? null
      : "port 要是 1–65535 的整數";
  }
  if (last === "bind") return string(bind);
  if (last === "database_url") return string(databaseUrl);
  if (last === "core_url") return string(wsUrl);
  if (last === "command_guilds") {
    if (!Array.isArray(value) || isTable(value)) return '要是陣列,例如 ["123456789012345678"]';
    for (const v of value) {
      if (typeof v !== "string") return '伺服器 id 要用字串,例如 ["123456789012345678"]';
      const err = discordId(v);
      if (err) return err;
    }
    return null;
  }
  if (last === "url" || last.endsWith("_url") || last.endsWith("_uri")) return string(httpUrl);
  return null;
}
