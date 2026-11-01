// A `.env` file edited line by line: comments, blank lines and order stay.

export function isEnvName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

function split(line: string): [string, string] | null {
  let t = line.trimStart();
  if (t.startsWith("#")) return null;
  if (t.startsWith("export ")) t = t.slice("export ".length).trimStart();
  const eq = t.indexOf("=");
  if (eq === -1) return null;
  const key = t.slice(0, eq).trim();
  return isEnvName(key) ? [key, t.slice(eq + 1)] : null;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.startsWith("'")) {
    const rest = v.slice(1);
    const end = rest.indexOf("'");
    return end === -1 ? rest : rest.slice(0, end);
  }
  if (v.startsWith('"')) {
    let out = "";
    const rest = v.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i] as string;
      if (c === '"') break;
      if (c === "\\") {
        const next = rest[++i];
        if (next === undefined) break;
        out += next === "n" ? "\n" : next;
      } else out += c;
    }
    return out;
  }
  const comment = v.indexOf(" #");
  return comment === -1 ? v : v.slice(0, comment).trimEnd();
}

/** Bare when safe; single quotes otherwise (no `$` expansion); double quotes as a last resort. */
export function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_\-./:@+,=%~?&]*$/.test(value)) return value;
  if (!value.includes("'") && !value.includes("\n")) return `'${value}'`;
  let out = '"';
  for (const c of value) {
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (c === "$") out += "\\$";
    else if (c === "\n") out += "\\n";
    else out += c;
  }
  return `${out}"`;
}

export class EnvFile {
  #lines: string[];
  #crlf: boolean;

  private constructor(lines: string[], crlf: boolean) {
    this.#lines = lines;
    this.#crlf = crlf;
  }

  static parse(text: string): EnvFile {
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return new EnvFile(lines, text.includes("\r\n"));
  }

  clone(): EnvFile {
    return new EnvFile([...this.#lines], this.#crlf);
  }

  render(): string {
    if (this.#lines.length === 0) return "";
    const nl = this.#crlf ? "\r\n" : "\n";
    return this.#lines.join(nl) + nl;
  }

  #position(key: string): number {
    return this.#lines.findIndex((l) => split(l)?.[0] === key);
  }

  /** Unquoted value; the first definition wins, as with dotenv. */
  get(key: string): string | undefined {
    for (const line of this.#lines) {
      const kv = split(line);
      if (kv && kv[0] === key) return unquote(kv[1]);
    }
    return undefined;
  }

  /** `(name, value)` of every variable, first definition only, in file order. */
  entries(): Array<[string, string]> {
    const seen = new Set<string>();
    const out: Array<[string, string]> = [];
    for (const line of this.#lines) {
      const kv = split(line);
      if (!kv || seen.has(kv[0])) continue;
      seen.add(kv[0]);
      out.push([kv[0], unquote(kv[1])]);
    }
    return out;
  }

  set(key: string, value: string): void {
    const line = `${key}=${quoteEnvValue(value)}`;
    const i = this.#position(key);
    if (i === -1) {
      this.#lines.push(line);
      return;
    }
    const exported = (this.#lines[i] as string).trimStart().startsWith("export ");
    this.#lines[i] = exported ? `export ${line}` : line;
  }

  unset(key: string): boolean {
    const before = this.#lines.length;
    this.#lines = this.#lines.filter((l) => split(l)?.[0] !== key);
    return this.#lines.length !== before;
  }
}
