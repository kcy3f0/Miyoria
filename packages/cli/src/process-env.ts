// The real process environment, captured before `.env` is loaded into it, so values can be
// attributed to `.env` or to the environment.

let captured: ReadonlyMap<string, string> | undefined;

export function captureProcessEnv(): void {
  if (captured) return;
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) map.set(k, v);
  captured = map;
}

export function capturedProcessEnv(): ReadonlyMap<string, string> {
  return captured ?? new Map();
}
