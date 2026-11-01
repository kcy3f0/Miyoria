#!/usr/bin/env node
// `miyoria` executable.

// `node:sqlite` (the default store) still prints an ExperimentalWarning on Node 24; it is noise
// for CLI users. Every other warning is kept.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  (emitWarning as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// `miyoria config list | head`: a closed pipe ends the command quietly.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

// Imported after the filter is in place.
const { main } = await import("./cli.js");
const code = await main(process.argv.slice(2));
process.exitCode = code;
// Exit even if a module left a handle open (the timer itself does not keep the process alive).
setTimeout(() => process.exit(code), 2000).unref();
