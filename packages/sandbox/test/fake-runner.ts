// A scripted `DockerRunner` for unit tests: records every call and answers control commands;
// `docker run` behaviour is supplied per test.

import type { DockerRunner, ExecOptions, ExecResult } from "../src/index.js";

export function result(over: Partial<ExecResult> = {}): ExecResult {
  const stdout = over.stdout ?? Buffer.alloc(0);
  const stderr = over.stderr ?? Buffer.alloc(0);
  return {
    exit_code: 0,
    stdout,
    stderr,
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    error: null,
    ...over,
  };
}

export type RunHandler = (
  args: readonly string[],
  options: ExecOptions,
  runner: FakeRunner,
) => Promise<ExecResult>;

/** Host source path of the `--mount` with `target`. */
export function mountSource(args: readonly string[], target: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--mount") continue;
    const value = args[i + 1] as string;
    if (value.endsWith(`target=${target}`) || value.includes(`target=${target},`)) {
      const match = /source=([^,]*)/.exec(value);
      return match?.[1] ?? null;
    }
  }
  return null;
}

export class FakeRunner implements DockerRunner {
  readonly calls: string[][] = [];
  dockerUp = true;
  imagePresent = true;
  psOutput = "";
  onRun: RunHandler = async () => result({ stdout: Buffer.from("ok\n") });
  #killed = new Set<string>();
  #killWaiters: Array<() => void> = [];

  /** Names passed to `docker kill`. */
  get killed(): string[] {
    return [...this.#killed];
  }

  /** Resolves when `docker kill` has been called for `name` (or any name). */
  waitForKill(): Promise<void> {
    if (this.#killed.size > 0) return Promise.resolve();
    return new Promise((resolve) => this.#killWaiters.push(resolve));
  }

  calledWith(command: string): string[][] {
    return this.calls.filter((c) => c[0] === command || `${c[0]} ${c[1]}` === command);
  }

  async exec(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    this.calls.push([...args]);
    const [command] = args;
    if (command === "version") {
      return this.dockerUp
        ? result({ stdout: Buffer.from("29.8.2\n") })
        : result({
            exit_code: 1,
            stderr: Buffer.from("error during connect: the docker daemon is not running\n"),
          });
    }
    if (command === "image") {
      return this.imagePresent ? result() : result({ exit_code: 1 });
    }
    if (command === "pull") {
      this.imagePresent = true;
      return result();
    }
    if (command === "ps") return result({ stdout: Buffer.from(this.psOutput) });
    if (command === "rm") return result();
    if (command === "kill") {
      this.#killed.add(args[args.length - 1] as string);
      for (const wake of this.#killWaiters.splice(0)) wake();
      return result();
    }
    if (command === "run") return this.onRun(args, options, this);
    return result({ exit_code: 1, stderr: Buffer.from(`unknown command ${command}`) });
  }
}
