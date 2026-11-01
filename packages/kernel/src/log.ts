// Logging: one pino root logger, scoped child loggers everywhere else.
//
//   const log = getLogger("llm.router");          // module-scope, at import time
//   log.warn({ model, err }, "model failed, trying next in chain");
//
// Modules use `ctx.log` (bound to `{ module: <id> }`). Messages are English; only user-facing
// strings (chat replies, CLI output, panel text) are Traditional Chinese.
//
// Loggers are bound lazily, so `configureLogging()` (called once by the app at boot) also
// reconfigures loggers created at import time.

import pino from "pino";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export type LogBindings = Record<string, unknown>;

export interface LogFn {
  /** Structured fields first, then the message. An `err` field is serialized as an error. */
  (fields: object, message?: string): void;
  (message: string): void;
}

export interface Logger {
  readonly fatal: LogFn;
  readonly error: LogFn;
  readonly warn: LogFn;
  readonly info: LogFn;
  readonly debug: LogFn;
  readonly trace: LogFn;
  child(bindings: LogBindings): Logger;
}

export interface LoggingOptions {
  /** Default: `$MIYORIA_LOG_LEVEL`, else `"silent"` under Vitest and `"info"` otherwise. */
  level?: LogLevel;
  /** Default: stdout (JSON lines). */
  destination?: pino.DestinationStream;
}

function defaultLevel(): LogLevel {
  const env = process.env.MIYORIA_LOG_LEVEL;
  if (env) return env as LogLevel;
  return process.env.VITEST ? "silent" : "info";
}

function makeRoot(options: LoggingOptions): pino.Logger {
  const config: pino.LoggerOptions = { level: options.level ?? defaultLevel() };
  return options.destination ? pino(config, options.destination) : pino(config);
}

let root = makeRoot({});
let generation = 0;

/** Replaces the root logger (level / destination). Existing loggers follow. */
export function configureLogging(options: LoggingOptions = {}): void {
  root = makeRoot(options);
  generation++;
}

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

class BoundLogger implements Logger {
  readonly #bindings: LogBindings;
  #inner: pino.Logger | undefined;
  #generation = -1;

  declare readonly fatal: LogFn;
  declare readonly error: LogFn;
  declare readonly warn: LogFn;
  declare readonly info: LogFn;
  declare readonly debug: LogFn;
  declare readonly trace: LogFn;

  constructor(bindings: LogBindings) {
    this.#bindings = bindings;
    for (const level of LEVELS) {
      const fn = (fields: object | string, message?: string) => {
        const inner = this.#target();
        if (typeof fields === "string") inner[level](fields);
        else inner[level](fields, message);
      };
      Object.defineProperty(this, level, { value: fn, enumerable: false });
    }
  }

  #target(): pino.Logger {
    if (this.#generation !== generation || this.#inner === undefined) {
      this.#inner = root.child(this.#bindings);
      this.#generation = generation;
    }
    return this.#inner;
  }

  child(bindings: LogBindings): Logger {
    return new BoundLogger({ ...this.#bindings, ...bindings });
  }
}

/** The root logger (no bindings). Prefer `getLogger(scope)` or `ctx.log`. */
export const rootLogger: Logger = new BoundLogger({});

/** Logger bound to `{ scope }`, e.g. `getLogger("kernel.supervisor")`. */
export function getLogger(scope: string): Logger {
  return new BoundLogger({ scope });
}
