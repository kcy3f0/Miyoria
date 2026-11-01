// Consistent terminal output: colored ✓ / ✗ / ! marks. Colors follow `NO_COLOR` / TTY
// detection (`util.styleText`). Writers can be swapped for tests (`setOutput`).

import { styleText } from "node:util";
import type { Reporter } from "./prompt.js";

type Style = Parameters<typeof styleText>[0];

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const processOutput: Output = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

let output: Output = processOutput;

/** Replaces the writers; returns a function restoring the previous ones. */
export function setOutput(next: Output): () => void {
  const prev = output;
  output = next;
  return () => {
    output = prev;
  };
}

function paint(style: Style, s: string, stream: NodeJS.WriteStream = process.stdout): string {
  if (output !== processOutput) return s;
  return styleText(style, s, { stream });
}

export const green = (s: string) => paint("green", s);
export const red = (s: string) => paint("red", s);
export const yellow = (s: string) => paint("yellow", s);
export const dim = (s: string) => paint("gray", s);
export const bold = (s: string) => paint("bold", s);
export const cyan = (s: string) => paint("cyan", s);

export function println(text = ""): void {
  output.out(`${text}\n`);
}

export function eprintln(text = ""): void {
  output.err(`${text}\n`);
}

export function ok(msg: string): void {
  println(`${green("✓")} ${msg}`);
}

export function fail(msg: string): void {
  eprintln(`${paint("red", "✗", process.stderr)} ${msg}`);
}

export function warn(msg: string): void {
  println(`${yellow("!")} ${msg}`);
}

export function note(msg: string): void {
  println(`${dim("·")} ${msg}`);
}

export function section(title: string): void {
  println(`\n${bold(cyan(title))}`);
}

/** Plain-terminal `Reporter` (scripting commands, `init --yes` without a TTY). */
export const plainReporter: Reporter = {
  intro: (title) => println(bold(title)),
  outro: (message) => println(`\n${message}`),
  section,
  note,
  ok,
  warn,
  fail,
  box: (title, lines) => {
    println(`\n${bold(title)}`);
    for (const line of lines) println(`  ${line}`);
  },
};
