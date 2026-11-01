// Minimal leveled logger. Never log tokens.
export type LogLevel = "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  const v = raw?.trim().toLowerCase();
  return v === "error" || v === "warn" || v === "info" || v === "debug" ? v : "info";
}

export function isEnabled(level: LogLevel): boolean {
  return ORDER[level] <= ORDER[threshold];
}

function emit(level: LogLevel, tag: string, args: unknown[]): void {
  if (!isEnabled(level)) return;
  const t = new Date().toISOString().slice(11, 23);
  const line = `${t} ${level.toUpperCase().padEnd(5)} [${tag}]`;
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export function createLogger(tag: string): Logger {
  return {
    error: (...a) => emit("error", tag, a),
    warn: (...a) => emit("warn", tag, a),
    info: (...a) => emit("info", tag, a),
    debug: (...a) => emit("debug", tag, a),
  };
}

export const noopLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};
