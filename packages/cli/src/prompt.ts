// Interactive questions behind an interface, so setup flows run against scripted answers in
// tests. `ClackPrompter` is the real terminal (@clack/prompts); `DefaultsPrompter` accepts every
// default (`miyoria init --yes` without a terminal).

import { styleText } from "node:util";
import * as clack from "@clack/prompts";
import type { Check } from "./validate.js";

/** Esc / Ctrl+C on a question: leave the current question / area. */
export class CancelledError extends Error {
  override readonly name = "CancelledError";

  constructor() {
    super("已取消");
  }
}

export function isCancelled(error: unknown): error is CancelledError {
  return error instanceof CancelledError;
}

/** Fails early (instead of hanging) when stdin / stdout are not a terminal. */
export class NotTtyError extends Error {
  override readonly name = "NotTtyError";

  constructor(hint = "在腳本裡請改用 `miyoria config set <key> <value>`") {
    super(`這個指令需要互動式終端機;${hint}`);
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Output used by the interactive flows. */
export interface Reporter {
  intro(title: string): void;
  outro(message: string): void;
  section(title: string): void;
  note(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
  fail(message: string): void;
  /** A framed block (e.g. the change summary). */
  box(title: string, lines: string[]): void;
}

export interface Prompter extends Reporter {
  /** Free text; Enter on an empty line returns `defaultValue`. */
  text(message: string, defaultValue: string, check?: Check): Promise<string>;
  /** Hidden input; `""` means "nothing typed". */
  secret(message: string): Promise<string>;
  select(message: string, options: string[], initial: number): Promise<number>;
  multiSelect(message: string, options: string[], initial: number[]): Promise<number[]>;
  confirm(message: string, initial: boolean): Promise<boolean>;
}

function dim(s: string): string {
  return styleText("dim", s);
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new CancelledError();
  return value as Exclude<T, symbol>;
}

/** The real terminal. */
export class ClackPrompter implements Prompter {
  intro(title: string): void {
    clack.intro(styleText(["bold", "cyan"], ` ${title} `));
  }

  outro(message: string): void {
    clack.outro(message);
  }

  section(title: string): void {
    clack.log.step(styleText(["bold", "cyan"], title));
  }

  note(message: string): void {
    clack.log.message(dim(message));
  }

  ok(message: string): void {
    clack.log.success(message);
  }

  warn(message: string): void {
    clack.log.warn(message);
  }

  fail(message: string): void {
    clack.log.error(message);
  }

  box(title: string, lines: string[]): void {
    clack.note(lines.join("\n"), title, { format: (l) => l });
  }

  async text(message: string, defaultValue: string, check?: Check): Promise<string> {
    const answer = await clack.text({
      message: defaultValue === "" ? message : `${message} ${dim("(Enter 保留目前的值)")}`,
      placeholder: defaultValue === "" ? undefined : defaultValue,
      defaultValue,
      validate: (raw) => {
        const value = raw === undefined || raw === "" ? defaultValue : raw;
        return check?.(value) ?? undefined;
      },
    });
    const value = unwrap(answer);
    return value === "" ? defaultValue : value;
  }

  async secret(message: string): Promise<string> {
    return unwrap(await clack.password({ message, mask: "•" })) ?? "";
  }

  async select(message: string, options: string[], initial: number): Promise<number> {
    const picked = await clack.select<number>({
      message: `${message} ${dim("(↑↓ 移動,Enter 選擇,Esc 返回)")}`,
      options: options.map((label, value) => ({ value, label })),
      initialValue: Math.min(Math.max(initial, 0), Math.max(options.length - 1, 0)),
      maxItems: 12,
      showInstructions: false,
    });
    return unwrap(picked);
  }

  async multiSelect(message: string, options: string[], initial: number[]): Promise<number[]> {
    const picked = await clack.multiselect<number>({
      message: `${message} ${dim("(↑↓ 移動,空白鍵勾選,Enter 確認,Esc 返回)")}`,
      options: options.map((label, value) => ({ value, label })),
      initialValues: initial,
      required: false,
      maxItems: 15,
      showInstructions: false,
    });
    return [...unwrap(picked)].sort((a, b) => a - b);
  }

  async confirm(message: string, initial: boolean): Promise<boolean> {
    return unwrap(
      await clack.confirm({ message, initialValue: initial, active: "是", inactive: "否" }),
    );
  }
}

/**
 * Answers every question with its default (secrets: nothing typed). Used by `init --yes` when
 * there is no terminal; output goes to `reporter`.
 */
export class DefaultsPrompter implements Prompter {
  constructor(readonly reporter: Reporter) {}

  intro(title: string): void {
    this.reporter.intro(title);
  }
  outro(message: string): void {
    this.reporter.outro(message);
  }
  /** Sections without questions would only print empty headings. */
  section(_title: string): void {}
  note(message: string): void {
    this.reporter.note(message);
  }
  ok(message: string): void {
    this.reporter.ok(message);
  }
  warn(message: string): void {
    this.reporter.warn(message);
  }
  fail(message: string): void {
    this.reporter.fail(message);
  }
  box(title: string, lines: string[]): void {
    this.reporter.box(title, lines);
  }
  async text(_message: string, defaultValue: string): Promise<string> {
    return defaultValue;
  }
  async secret(): Promise<string> {
    return "";
  }
  async select(_message: string, _options: string[], initial: number): Promise<number> {
    return initial;
  }
  async multiSelect(_message: string, _options: string[], initial: number[]): Promise<number[]> {
    return initial;
  }
  async confirm(_message: string, initial: boolean): Promise<boolean> {
    return initial;
  }
}
