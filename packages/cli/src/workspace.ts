// `miyoria.toml` + `.env` (+ the active profile's `profile.toml`) loaded for editing. Nothing
// touches the disk until `save()`. Missing files can start from templates, and `init` can plan
// to scaffold the bundled profile and the data directory; those are created by `save()` too.
//
// Secrets live in `.env`; `miyoria.toml` points at them with `${VAR}` / `${VAR:-default}`.
// Callers that edit a key holding such a reference write the variable and leave the reference.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { profileIds } from "./assets.js";
import { EnvFile } from "./env-file.js";
import { capturedProcessEnv } from "./process-env.js";
import {
  display,
  envRefs,
  expand,
  isSecret,
  type Lookup,
  mask,
  maskUrl,
  type Source,
} from "./refs.js";
import {
  formatKey,
  isTable,
  leaves,
  parseKey,
  parseTomlText,
  plainValue,
  showValue,
  TomlDocument,
  type TomlTable,
  type TomlValue,
} from "./toml-patch.js";

const GITIGNORE = "# Miyoria:密碼和資料庫不要進 git\n.env\ndata/\n";

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}

/** Directory holding `miyoria.toml` (and `.env`). */
export function configDir(configPath: string): string {
  return dirname(resolve(configPath));
}

// ---- changes -----------------------------------------------------------------------------

export type Target = "toml" | "env" | "profile";

/** One changed key; `old` / `new` are display strings with secrets masked. */
export interface Change {
  target: Target;
  key: string;
  old: string | null;
  new: string | null;
}

export function renderChange(c: Change): string {
  if (c.old === null && c.new !== null) return `+ ${c.key} = ${c.new}`;
  if (c.old !== null && c.new !== null) return `~ ${c.key}: ${c.old} → ${c.new}`;
  if (c.old !== null) return `- ${c.key}(原本 ${c.old})`;
  return `  ${c.key}`;
}

function leafDisplay(path: string[], value: TomlValue): string {
  if (typeof value === "string") {
    if (!value.includes("${") && isSecret(path.at(-1) ?? "")) return `"${mask(value)}"`;
    if (value.includes("@")) return `"${maskUrl(value)}"`;
  }
  return showValue(value);
}

function leafMap(data: TomlTable): Array<[string, string]> {
  return leaves(data).map((l) => [formatKey(l.path), leafDisplay(l.path, l.value)]);
}

function diffPairs(
  before: Array<[string, string]>,
  after: Array<[string, string]>,
  target: Target,
): Change[] {
  const old = new Map(before);
  const newKeys = new Set(after.map(([k]) => k));
  const out: Change[] = [];
  for (const [k, v] of after) {
    const o = old.get(k);
    if (o !== v) out.push({ target, key: k, old: o ?? null, new: v });
  }
  for (const [k, v] of before) {
    if (!newKeys.has(k)) out.push({ target, key: k, old: v, new: null });
  }
  return out;
}

export function diffToml(base: string, now: TomlTable, target: Target): Change[] {
  let before: Array<[string, string]> = [];
  try {
    before = leafMap(parseTomlText(base));
  } catch {
    // an unparsable base shows everything as new
  }
  return diffPairs(before, leafMap(now), target);
}

export function diffEnv(base: EnvFile, now: EnvFile): Change[] {
  const shown = (e: EnvFile): Array<[string, string]> =>
    e.entries().map(([k, v]) => [k, display(k, v, false)]);
  return diffPairs(shown(base), shown(now), "env");
}

// ---- workspace ---------------------------------------------------------------------------

interface ProfileDoc {
  path: string;
  doc: TomlDocument;
  base: string;
  exists: boolean;
}

/** A bundled profile `init` will copy into the profiles directory. */
export interface PlannedProfile {
  id: string;
  from: string;
  to: string;
}

export interface WorkspaceOptions {
  /** The real environment (default: captured at CLI start). */
  processEnv?: ReadonlyMap<string, string>;
  /** Where bundled profiles come from (for `planScaffold`). */
  bundledProfiles?: string | null;
}

function readOr(path: string, template: string): [string, boolean] {
  try {
    return [readFileSync(path, "utf8"), true];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [template, false];
    throw new WorkspaceError(`讀取 ${path} 失敗:${(error as Error).message}`, { cause: error });
  }
}

function parseDoc(text: string, path: string): TomlDocument {
  try {
    return TomlDocument.parse(text);
  } catch (error) {
    throw new WorkspaceError(`${path} 不是合法的 TOML:${(error as Error).message}`, {
      cause: error,
    });
  }
}

export class Workspace {
  readonly configPath: string;
  readonly envPath: string;
  doc: TomlDocument;
  env: EnvFile;
  /** Notes collected while editing (shown before confirming). */
  readonly warnings: string[] = [];
  /** Bundled profiles to copy on save. */
  readonly plannedProfiles: PlannedProfile[] = [];
  /** `.gitignore` to create next to the config (keeps `.env` and the database out of git). */
  plannedGitignore: string | null = null;
  #tomlBase: string;
  #envBase: EnvFile;
  #tomlExists: boolean;
  #envExists: boolean;
  #profile: ProfileDoc | null = null;
  readonly #processEnv: ReadonlyMap<string, string>;
  readonly #bundled: string | null;

  private constructor(
    configPath: string,
    tomlText: string,
    tomlExists: boolean,
    envText: string,
    envExists: boolean,
    options: WorkspaceOptions,
  ) {
    this.configPath = configPath;
    this.envPath = join(configDir(configPath), ".env");
    this.doc = parseDoc(tomlText, configPath);
    this.env = EnvFile.parse(envText);
    this.#envBase = this.env.clone();
    this.#tomlBase = tomlText;
    this.#tomlExists = tomlExists;
    this.#envExists = envExists;
    this.#processEnv = options.processEnv ?? capturedProcessEnv();
    this.#bundled = options.bundledProfiles ?? null;
  }

  /** Opens existing files; a missing `miyoria.toml` is an error. */
  static open(configPath: string, options: WorkspaceOptions = {}): Workspace {
    if (!existsSync(configPath)) {
      throw new WorkspaceError(`找不到 ${configPath}:先執行 \`miyoria init\` 建立設定`);
    }
    return Workspace.openOrCreate(configPath, "", "", options);
  }

  /** Opens the files, starting missing ones from the templates. */
  static openOrCreate(
    configPath: string,
    tomlTemplate: string,
    envTemplate: string,
    options: WorkspaceOptions = {},
  ): Workspace {
    const envPath = join(configDir(configPath), ".env");
    const [tomlText, tomlExists] = readOr(configPath, tomlTemplate);
    const [envText, envExists] = readOr(envPath, envTemplate);
    return new Workspace(configPath, tomlText, tomlExists, envText, envExists, options);
  }

  get dir(): string {
    return configDir(this.configPath);
  }

  get tomlExists(): boolean {
    return this.#tomlExists;
  }

  /** Value of a variable: the real environment wins over `.env`, as at runtime. */
  lookup(name: string): [string, Source] | undefined {
    const proc = this.#processEnv.get(name);
    if (proc !== undefined && proc !== "") return [proc, "process"];
    const v = this.env.get(name);
    return v === undefined ? undefined : [v, "dotenv"];
  }

  resolve(s: string): [string, Array<[string, Source]>] {
    const lookup: Lookup = (name) => this.lookup(name);
    return expand(s, lookup);
  }

  item(key: string): TomlValue | undefined {
    try {
      return this.doc.get(parseKey(key));
    } catch {
      return undefined;
    }
  }

  /** Effective value of a key with references expanded. */
  effective(key: string): string | undefined {
    const value = this.item(key);
    if (value === undefined || isTable(value)) return undefined;
    return typeof value === "string" ? this.resolve(value)[0] : plainValue(value);
  }

  set(key: string, value: TomlValue): void {
    this.doc.set(parseKey(key), value);
  }

  unset(key: string): boolean {
    return this.doc.unset(parseKey(key));
  }

  setEnv(name: string, value: string): void {
    const proc = this.#processEnv.get(name);
    if (proc !== undefined && proc !== "") {
      this.warnings.push(`${name} 也設在系統環境變數裡,執行時會蓋過 .env 的值`);
    }
    this.env.set(name, value);
  }

  /** `miyoria.toml` keys whose strings reference `${variable}`. */
  references(variable: string): string[] {
    const mentions = (v: TomlValue): boolean => {
      if (typeof v === "string") return envRefs(v).some((r) => r.name === variable);
      if (Array.isArray(v)) return v.some(mentions);
      if (isTable(v)) return Object.values(v).some(mentions);
      return false;
    };
    return leaves(this.doc.data)
      .filter((l) => mentions(l.value))
      .map((l) => formatKey(l.path));
  }

  // ---- profiles ----------------------------------------------------------------------------

  profilesDir(): string {
    const dir = this.effective("core.profiles_dir");
    return resolve(this.dir, dir === undefined || dir === "" ? "profiles" : dir);
  }

  /** Profiles on disk plus the ones planned for scaffolding, sorted. */
  listProfiles(): string[] {
    const ids = new Set(profileIds(this.profilesDir()));
    for (const p of this.plannedProfiles) ids.add(p.id);
    return [...ids].sort();
  }

  /**
   * Plans copying the bundled profiles when the profiles directory has none, or the selected
   * profile is a bundled one that is missing. Returns the planned ids.
   */
  planScaffold(): string[] {
    const bundled = profileIds(this.#bundled);
    if (this.#bundled === null || bundled.length === 0) return [];
    const local = profileIds(this.profilesDir());
    const selected = this.effective("core.profile") ?? "";
    const wanted =
      local.length === 0 ? bundled : bundled.filter((id) => id === selected && !local.includes(id));
    for (const id of wanted) {
      if (this.plannedProfiles.some((p) => p.id === id)) continue;
      this.plannedProfiles.push({
        id,
        from: join(this.#bundled, id),
        to: join(this.profilesDir(), id),
      });
    }
    return wanted;
  }

  /** Plans a `.gitignore` when the directory has none. */
  planGitignore(): void {
    const path = join(this.dir, ".gitignore");
    if (!existsSync(path)) this.plannedGitignore = path;
  }

  profilePath(): string | undefined {
    const id = this.effective("core.profile");
    if (id === undefined || id === "") return undefined;
    return join(this.profilesDir(), id, "profile.toml");
  }

  /**
   * The active profile's `profile.toml`, loaded on first use (and again when `core.profile`
   * changed). A planned bundled profile is read from the bundle.
   */
  profileDoc(): TomlDocument | undefined {
    const path = this.profilePath();
    if (path === undefined) return undefined;
    if (this.#profile?.path === path) return this.#profile.doc;
    let text: string;
    let exists = true;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      const planned = this.plannedProfiles.find((p) => join(p.to, "profile.toml") === path);
      if (!planned) return undefined;
      try {
        text = readFileSync(join(planned.from, "profile.toml"), "utf8");
      } catch {
        return undefined;
      }
      exists = false;
    }
    let doc: TomlDocument;
    try {
      doc = TomlDocument.parse(text);
    } catch {
      return undefined;
    }
    this.#profile = { path, doc, base: text, exists };
    return doc;
  }

  // ---- saving ------------------------------------------------------------------------------

  /** `sqlite:` data directory that does not exist yet (created by `save`). */
  dataDirToCreate(): string | undefined {
    const url = this.effective("core.database_url") ?? "";
    const m = /^sqlite:(?:\/\/)?(.+)$/.exec(url);
    const file = m?.[1];
    if (file === undefined || file === ":memory:") return undefined;
    const dir = dirname(isAbsolute(file) ? file : resolve(this.dir, file));
    return existsSync(dir) ? undefined : dir;
  }

  /** Files and directories that do not exist yet and will be created by `save`. */
  missingFiles(): string[] {
    const out: string[] = [];
    if (!this.#tomlExists) out.push(this.configPath);
    if (!this.#envExists) out.push(this.envPath);
    for (const p of this.plannedProfiles) {
      if (!existsSync(p.to)) out.push(`${p.to}(內建角色 ${p.id})`);
    }
    const data = this.dataDirToCreate();
    if (data !== undefined) out.push(`${data}(資料庫資料夾)`);
    if (this.plannedGitignore !== null && !existsSync(this.plannedGitignore)) {
      out.push(this.plannedGitignore);
    }
    return out;
  }

  changes(): Change[] {
    const out = diffToml(this.#tomlBase, this.doc.data, "toml");
    out.push(...diffEnv(this.#envBase, this.env));
    const p = this.#profile;
    if (p) out.push(...diffToml(p.base, p.doc.data, "profile"));
    return out;
  }

  pathOf(target: Target): string | undefined {
    if (target === "toml") return this.configPath;
    if (target === "env") return this.envPath;
    return this.#profile?.path;
  }

  /** Path shown to the user: relative to the current directory when shorter. */
  shown(path: string): string {
    const rel = relative(process.cwd(), path);
    return rel !== "" && !rel.startsWith("..") && rel.length < path.length ? rel : path;
  }

  /** Writes changed (or missing) files and planned scaffolding; returns the paths written. */
  save(): string[] {
    const written: string[] = [];
    mkdirSync(this.dir, { recursive: true });
    for (const p of this.plannedProfiles.splice(0)) {
      if (existsSync(p.to)) continue;
      cpSync(p.from, p.to, { recursive: true, filter: (src) => !isLocalOnlyAsset(src) });
      written.push(p.to);
    }
    const toml = this.doc.toString();
    if (!this.#tomlExists || toml !== this.#tomlBase) {
      write(this.configPath, toml);
      written.push(this.configPath);
      this.#tomlBase = toml;
      this.#tomlExists = true;
    }
    const env = this.env.render();
    if (!this.#envExists || env !== this.#envBase.render()) {
      write(this.envPath, env);
      written.push(this.envPath);
      this.#envBase = this.env.clone();
      this.#envExists = true;
    }
    const p = this.#profile;
    if (p) {
      const text = p.doc.toString();
      if (text !== p.base || !existsSync(p.path)) {
        mkdirSync(dirname(p.path), { recursive: true });
        write(p.path, text);
        if (!written.some((w) => p.path.startsWith(w))) written.push(p.path);
        p.base = text;
        p.exists = true;
      }
    }
    const data = this.dataDirToCreate();
    if (data !== undefined) {
      mkdirSync(data, { recursive: true });
      written.push(data);
    }
    const gitignore = this.plannedGitignore;
    this.plannedGitignore = null;
    if (gitignore !== null && !existsSync(gitignore)) {
      write(gitignore, GITIGNORE);
      written.push(gitignore);
    }
    return written;
  }
}

/** Third-party profile assets that are never redistributed (see the repo's .gitignore). */
export function isLocalOnlyAsset(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  return /\/avatar\/model(\/|$)/.test(p) || /\/voice\/[^/]+\.(wav|txt)$/.test(p);
}

function write(path: string, text: string): void {
  try {
    writeFileSync(path, text);
  } catch (error) {
    throw new WorkspaceError(`寫入 ${path} 失敗:${(error as Error).message}`, { cause: error });
  }
}
