// Answers questions from a script and records what was asked and printed.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancelledError, type Prompter } from "../src/prompt.js";
import type { Check } from "../src/validate.js";

export type Answer =
  | "enter"
  | "yes"
  | "no"
  | "cancel"
  | { text: string }
  | { pick: number }
  | { picks: number[] };

export const Enter = "enter" as const;
export const Yes = "yes" as const;
export const No = "no" as const;
export const Cancel = "cancel" as const;
export const Text = (text: string): Answer => ({ text });
export const Pick = (pick: number): Answer => ({ pick });
export const Picks = (...picks: number[]): Answer => ({ picks });

export class Scripted implements Prompter {
  readonly asked: string[] = [];
  readonly printed: string[] = [];
  readonly #answers: Answer[];

  constructor(answers: Answer[]) {
    this.#answers = [...answers];
  }

  get done(): boolean {
    return this.#answers.length === 0;
  }

  #next(message: string): Answer {
    this.asked.push(message);
    const answer = this.#answers.shift();
    if (answer === undefined) {
      throw new Error(
        `no scripted answer for ${JSON.stringify(message)}; asked ${JSON.stringify(this.asked)}`,
      );
    }
    if (answer === "cancel") throw new CancelledError();
    return answer;
  }

  intro(title: string): void {
    this.printed.push(`intro: ${title}`);
  }
  outro(message: string): void {
    this.printed.push(`outro: ${message}`);
  }
  section(title: string): void {
    this.printed.push(`section: ${title}`);
  }
  note(message: string): void {
    this.printed.push(`note: ${message}`);
  }
  ok(message: string): void {
    this.printed.push(`ok: ${message}`);
  }
  warn(message: string): void {
    this.printed.push(`warn: ${message}`);
  }
  fail(message: string): void {
    this.printed.push(`fail: ${message}`);
  }
  box(title: string, lines: string[]): void {
    this.printed.push(`box: ${title}\n${lines.join("\n")}`);
  }

  async text(message: string, defaultValue: string, check?: Check): Promise<string> {
    const a = this.#next(message);
    let value: string;
    if (a === "enter") value = defaultValue;
    else if (typeof a === "object" && "text" in a) value = a.text;
    else throw new Error(`${JSON.stringify(message)} expects text, got ${JSON.stringify(a)}`);
    const err = check?.(value);
    if (err)
      throw new Error(`${JSON.stringify(message)}: ${JSON.stringify(value)} rejected: ${err}`);
    return value;
  }

  async secret(message: string): Promise<string> {
    const a = this.#next(message);
    if (a === "enter") return "";
    if (typeof a === "object" && "text" in a) return a.text;
    throw new Error(`${JSON.stringify(message)} expects a secret, got ${JSON.stringify(a)}`);
  }

  async select(message: string, options: string[], initial: number): Promise<number> {
    const a = this.#next(message);
    if (a === "enter") return initial;
    if (typeof a === "object" && "pick" in a) {
      if (a.pick >= options.length)
        throw new Error(`${message}: no option ${a.pick} in ${options}`);
      return a.pick;
    }
    throw new Error(`${JSON.stringify(message)} expects a choice, got ${JSON.stringify(a)}`);
  }

  async multiSelect(message: string, _options: string[], initial: number[]): Promise<number[]> {
    const a = this.#next(message);
    if (a === "enter") return initial;
    if (typeof a === "object" && "picks" in a) return a.picks;
    throw new Error(`${JSON.stringify(message)} expects choices, got ${JSON.stringify(a)}`);
  }

  async confirm(message: string, initial: boolean): Promise<boolean> {
    const a = this.#next(message);
    if (a === "enter") return initial;
    if (a === "yes") return true;
    if (a === "no") return false;
    throw new Error(`${JSON.stringify(message)} expects yes/no, got ${JSON.stringify(a)}`);
  }
}

/** A fresh, empty directory under the system temp dir. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "miyoria-cli-test-"));
}
