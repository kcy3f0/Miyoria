# TypeScript conventions

Miyoria is being rewritten from Rust (`legacy/rust/`) to TypeScript. The Rust code is the
**behavioural reference**: same module ids, config keys, event topics, JSON shapes, defaults and
tests. When in doubt, read the Rust crate and do what it does.

Runtime: **Node 24**, **pnpm 9**, ESM only, strict TypeScript 5.9. Database default: SQLite
(`node:sqlite`), Postgres optional.

## 1. Workspace

| Path | Package | Notes |
|---|---|---|
| `packages/<name>` | `@miyoria/<name>` | libraries and modules (`types`, `kernel`, `llm`, ...) |
| `apps/<name>` | `@miyoria/<name>` | executables (`core`, `voice-node`, `panel`, ...); the CLI ships as `miyoria` |
| `extensions/**` | `@miyoria/ext-<name>` | extensions (use `@miyoria/sdk` only) |

Root scripts: `pnpm typecheck` / `pnpm test` / `pnpm build` (each = `pnpm -r <script>`),
`pnpm lint` (Biome check), `pnpm format`, `pnpm test:watch` (all Node projects in one Vitest).

### Source resolution (no build needed for typecheck / test / dev)

Every workspace package exports a custom condition first:

```json
"exports": {
  ".": {
    "@miyoria/source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

- `tsc --noEmit` (`typecheck`) uses `customConditions: ["@miyoria/source"]` from
  `tsconfig.base.json`, so dependencies are type-checked from their `src`.
- Vitest gets the same condition from `vitest.shared.ts` (`nodeProject()`).
- Dev: `tsx --conditions=@miyoria/source src/main.ts`.
- `build` (`tsconfig.build.base.json`) clears the condition and resolves dependencies to their
  `dist/*.d.ts`; `pnpm -r build` runs in dependency order. Plain `node` resolves `dist`.

### New package checklist

```
packages/<name>/
  package.json          # copy packages/tools/package.json: name, deps, same exports/scripts
  tsconfig.json         # { "extends": "../../tsconfig.base.json" }
  tsconfig.build.json   # { "extends": "../../tsconfig.build.base.json" }
  vitest.config.ts      # import { nodeProject } from "../../vitest.shared.ts"; export default nodeProject();
  src/index.ts          # the only entry point; explicit named re-exports
  test/*.test.ts        # (or src/**/*.test.ts, excluded from the build)
```

Dependencies on other packages are `"@miyoria/<x>": "workspace:*"`. Add a third-party dependency
only when it clearly pays for itself; prefer Node built-ins (`fetch`, `node:crypto`,
`node:sqlite`, `util.parseEnv`, `AbortSignal`). Run `pnpm install` from the root (one
`pnpm-lock.yaml`).

## 2. Naming and shapes

- Files `kebab-case.ts`; types / classes `PascalCase`; functions / variables `camelCase`;
  constants `UPPER_SNAKE` only for true constants (`STOP_TIMEOUT_MS`). TS-side durations carry
  their unit (`timeoutMs`, `backoff_ms` log fields); JSON fields keep the legacy name (`ttl`, `asr_ms`).
- Relative imports end in `.js` (`import { x } from "./bus.js"`); type-only imports use
  `import type` (`verbatimModuleSyntax`).
- **Wire / persisted data mirrors the Rust serde JSON exactly.** Any type that is serialized
  (events, actions, store records, API bodies, config sections, protocol messages) keeps Rust's
  snake_case field names, and:
  - `Option<T>` → `T | null`, key always present (serde writes `null`). Pure in-process option
    bags may use `?:` instead.
  - `#[serde(tag = "type", content = "data")]` → `{ type: "snake_case", data: ... }`;
    `#[serde(tag = "type")]` → `{ type: "snake_case", ...fields }`; unit enums → string unions.
  - `DateTime<Utc>` → `Timestamp` (RFC 3339 string; compare with `Date.parse`);
    `Duration` → number of ms (as legacy serialized it); ULIDs → `string` (`newId()`).
  - `HashMap` / `BTreeMap` in return values → `Map` (BTreeMap: keys ascending).
- TS-only APIs (methods, constructor options, classes without serde in Rust) are camelCase:
  `store.dueFollowups(...)`, `new OpenAiConfig(...).timeoutMs`.
- **Module ids, config keys, event topics, service names, permission nodes, settings keys and
  every JSON shape must match legacy exactly.** Grep the Rust code before inventing a name.
- Language: code, comments, logs and errors in English. Only user-facing strings (chat
  replies, prompt text, CLI output, panel text) are Traditional Chinese, copied from legacy.

## 3. Errors

- Throw `Error` subclasses with a `name` and a message in the legacy wording
  (`` `unknown module \`${id}\`` ``). Keep data on the error (`code`, `status`, `path`), attach
  causes with `{ cause }`.
- No `any` (Biome errors on it). Use `unknown` + narrowing, zod for untrusted input.
- Never put secrets in messages, logs or `toJSON` / `util.inspect` output (see
  `OpenAiConfig`).
- `catch (error)` is `unknown`; use `errorMessage(error)` from `@miyoria/kernel` for text.

## 4. Async and cancellation

- Every cancellable or long-running call takes an `AbortSignal` (last parameter or in an
  options object) and passes it on (`fetch`, `sleep`, child calls). Module code uses
  `ctx.signal` / the task's signal.
- No floating promises (Biome `noFloatingPromises` is an error). Await, return, or hand the
  work to `ctx.spawn`. Fire-and-forget is only `void p.catch(log)` with a reason.
- Use `sleep(ms, signal)`, `interval(ms, signal)`, `withTimeout`, `SerialQueue` from
  `@miyoria/kernel`. They use global timers, so Vitest fake timers control them; do not use
  `node:timers/promises`.
- Streams are `AsyncIterable`s (`for await`, `break` to stop; implement `return()` cleanup).

## 5. Logging

- One pino root, configured once by the app (`configureLogging({ level })`; env
  `MIYORIA_LOG_LEVEL`; silent under Vitest).
- Module code logs with `ctx.log` (bound to `{ module }`); library code creates a scoped logger
  at import time: `const log = getLogger("llm.router")`.
- Structured fields first: `log.warn({ model, err }, "model failed, trying next in chain")`.
  Messages are the legacy `tracing` messages.

## 6. Config

- Loading: `loadDotenv(configPath)` (`.env` next to `miyoria.toml`, never overrides the
  environment), then `Config.load(path)`: TOML via `smol-toml`, `${VAR}` / `${VAR:-default}`
  interpolation, `config.module(id)` → `{ enabled, config }` (`enabled = false` disables).
- Every module exports a **zod** schema of its section with defaults equal to the Rust
  `Default` impls. `z.object` (unknown keys ignored, like serde) with `.default(...)` per field;
  nested sections use **`.prefault({})`** (zod 4's `.default({})` skips parsing and would drop
  the nested defaults).
- In `start`: `const cfg = ctx.config(MyConfigSchema)` (missing section = `{}`); an invalid
  config throws `ConfigError` and fails the start. Put the schema in the manifest
  (`configSchema`) so the panel gets a JSON Schema (`manifestJson`).

## 7. Time

Never call `Date.now()` / `new Date()` in logic you want to test. Take a `Clock`
(`{ now(): number }`, `systemClock` by default; modules have `ctx.clock`) or use Vitest fake
timers (`vi.useFakeTimers()` also fakes `Date.now()` and the kernel timers).

## 8. Kernel API (what modules see)

```ts
import { defineManifest, type Module, type ModuleContext } from "@miyoria/kernel";

export const SchedulerConfigSchema = z.object({ text_rate_ms: z.number().default(1000) });

export class SchedulerModule implements Module {
  static readonly ID = "scheduler";
  readonly manifest = defineManifest(SchedulerModule.ID, "Scheduler", {
    requires: ["llm"], optional: ["voice"], configSchema: SchedulerConfigSchema,
  });

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(SchedulerConfigSchema);
    ctx.provide(ActionSinkKey, new Scheduler(cfg));            // removed again on stop
    const sinks = ctx.services.require(PlatformSinksKey);      // throws ServiceUnavailableError
    const sub = ctx.subscribe(["platform.*", "agent.turn.completed"]); // closed on stop
    ctx.spawn("events", async (signal) => {
      for await (const env of sub) { /* env.event is the Event union; narrow on .type */ }
    });
    ctx.publish(customEvent("scheduler.ready", null), { turn: null });
  }

  async stop(): Promise<void> { /* optional; runs before tasks are aborted */ }
}
```

- `start` returns quickly; long work goes into `ctx.spawn(name, (signal) => ...)`. A task (or
  `start`) that rejects before stop marks the module `failed`; the supervisor restarts it with
  backoff 2 s, 4 s, 8 s ... (max 60 s), giving up after 5 failures in 10 minutes. Tasks must
  settle within 5 s of `signal` aborting.
- `Supervisor`: `register(module, config, enabled)`, `startAll()` (topological over
  `requires` + `optional`), `stopAll()`, `enable / disable / restart(id)`, `list()` →
  `ModuleStatus[]` (legacy JSON). Disabling a module stops everything that `requires` it.
  Every transition is published as `system.module.state` from source `kernel`. Never call the
  supervisor from inside `start` / `stop` (deadlock); from tasks is fine. The app provides it
  as `SupervisorKey` for admin modules.
- `EventBus`: `publish(source, event, { correlation, causation })`, `subscribe(filter)`
  (`"*"`, `"prefix.*"`, exact; string or list) → `Subscription` (`for await`, `recv()`,
  `tryRecv()`, `close()`); per-subscriber buffer of 4096, oldest dropped on lag.

### Services: `ServiceKey<T>`

Rust's `services().get::<dyn Trait>()` becomes a typed token declared next to the interface:

```ts
export interface ActionSink { submit(action: Action): Promise<void>; cancelTurn(turn: TurnId): Promise<void> }
export const ActionSinkKey = serviceKey<ActionSink>("ActionSink"); // id = Rust type name

ctx.provide(ActionSinkKey, impl);          // owner = this module, removed when it stops
ctx.services.get(ActionSinkKey);           // ActionSink | undefined
ctx.services.require(ActionSinkKey);       // or throws ServiceUnavailableError
```

Keys exist for every legacy service: `ActionSinkKey`, `VoiceSinkKey`, `AuthorizerKey`,
`SocialSignalsKey`, `MoodSignalsKey`, `FollowupSourceKey`, `PlatformSinksKey`,
`PromptContributorsKey` (`@miyoria/types`), `SupervisorKey` (`kernel`), `LlmRouterKey`
(`llm`), `ToolRegistryKey` (`tools`), one per store area plus `StoreKey` (`store`). A module that
owns a new service exports its key from its own package. Look services up when needed; don't
cache another module's service across its restarts.

## 9. Porting a Rust crate

| Rust | TypeScript |
|---|---|
| crate `miyoria-foo` | package `@miyoria/foo` (`packages/foo`) |
| `trait Foo` used as `Arc<dyn Foo>` | `interface Foo` + `FooKey = serviceKey<Foo>("Foo")` |
| trait default method | abstract base class (`BaseAuthorizer`) or a helper function |
| `impl Module for X` | `class X implements Module` with `static readonly ID` |
| `ctx.config::<T>()` + `#[serde(default)]` | zod schema + `ctx.config(Schema)` |
| `tokio::spawn` inside a module | `ctx.spawn(name, (signal) => ...)` |
| `CancellationToken` / `select!` on cancel | `AbortSignal`; `sleep(ms, signal)`, `interval` |
| `broadcast` / `bus.subscribe` loop | `ctx.subscribe(filter)` + `for await` |
| `mpsc` channel between own tasks | an `AsyncIterable` queue or direct method calls |
| `Mutex` around async state | `SerialQueue`; plain fields for sync state (single thread) |
| `parking_lot::RwLock<HashMap>` | `Map` |
| `anyhow::bail!("...")` | `throw new FooError("...")` (same message) |
| `tracing::warn!(x = %y, "msg")` | `log.warn({ x: y }, "msg")` |
| `#[cfg(test)] mod tests` / `tests/*.rs` | `test/*.test.ts`, same test names (snake_case is fine) |
| `tokio::time::pause` / `advance` | `vi.useFakeTimers()` / `await vi.advanceTimersByTimeAsync(ms)` |

Keep file structure close to the Rust modules so reviewers can diff behaviour.

## 10. Tests

- Vitest, `test/*.test.ts`. **Port every Rust test** of the crate (keep its name), then add
  tests for TS-specific behaviour (cancellation, JSON shapes).
- Time-dependent code: fake timers or an injected `Clock`. Restore with `vi.useRealTimers()`
  in `afterEach`.
- No real network. HTTP clients are tested against a local `node:http` server on
  `127.0.0.1:0` (see `packages/llm/test/openai.test.ts`); other I/O through in-memory
  implementations (`MemorySettingsStore`, `MockProvider`).
- Module tests run the real `Supervisor`: register, `startAll()`, assert on services, events
  (`sub.tryRecv()`) and `list()`, then `stopAll()`.
- Temp files under `os.tmpdir()` (`mkdtempSync`), removed in `finally`.

## 11. Lint and format

Biome (`biome.json`): 2-space indent, 100 columns, double quotes, trailing commas, organized
imports, recommended rules plus `noExplicitAny`, `useImportType`, `noFloatingPromises`. Run
`pnpm format` before committing. The packages that existed before the rewrite (`apps/panel`,
`apps/overlay`, `apps/voice-node`, `packages/sdk`, `extensions/minecraft/adapter`,
`extensions/examples/hello`) are lint-only with their
current violations switched off (see the override); new packages get the full rules.
