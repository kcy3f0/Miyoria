// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configuredModules } from "@miyoria/core/light";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exampleConfig } from "../src/assets.js";
import * as config from "../src/commands/config.js";
import { parseKey } from "../src/toml-patch.js";
import { type Output, setOutput } from "../src/ui.js";
import { type Change, renderChange, Workspace } from "../src/workspace.js";
import { Picks, Scripted, Text, tempDir, Yes } from "./scripted.js";

let dir: string;
let path: string;
let out: string[];
let restore: () => void;

beforeEach(() => {
  dir = tempDir();
  path = join(dir, "miyoria.toml");
  writeFileSync(path, exampleConfig());
  out = [];
  const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
  restore = setOutput(sink);
});

afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true });
});

const text = () => out.join("");
const read = (p: string) => readFileSync(join(dir, p), "utf8");

describe("config", () => {
  it("env_names_for_new_secrets", () => {
    expect(config.envNameFor(parseKey('modules."platform.x".api_key'))).toBe("PLATFORM_X_API_KEY");
  });

  it("classifies_restarts", () => {
    const ws = Workspace.open(path);
    const change = (target: Change["target"], key: string, value: string | null): Change => ({
      target,
      key,
      old: null,
      new: value,
    });
    const [toggles, areas] = config.classify(ws, [
      change("toml", "modules.agent.enabled", "false"),
      change("toml", "modules.memory.enabled", null),
      change("toml", "speech.tts.local.voice", '"x"'),
      change("env", "MIYORIA_OWNER_ID", "1"),
      change("env", "STAGE_LINK_TOKEN", "1"),
    ]);
    expect(toggles).toEqual([
      ["agent", false],
      ["memory", true],
    ]);
    expect(areas).toEqual(["auth", "commands", "speech", "stage 節點", "stage.link"]);
  });

  it("menu_areas_edit_only_picked_fields", async () => {
    writeFileSync(join(dir, ".env"), "OBS_PASSWORD=old-password-123\n");
    const ws = Workspace.open(path, { processEnv: new Map() });
    // Stage: pick OBS port (5) and enable OBS (3).
    await config.runArea("stage", new Scripted([Picks(3, 5), Yes, Text("4456")]), ws);
    expect(ws.changes().map(renderChange)).toEqual([
      "~ stage.obs.enabled: false → true",
      "~ stage.obs.port: 4455 → 4456",
    ]);

    // Modules: turn off agent.
    const mods = configuredModules(config.workspaceConfig(ws));
    const keep = mods.flatMap(([id], i) => (id === "agent" ? [] : [i]));
    await config.runArea("modules", new Scripted([Picks(...keep)]), ws);
    expect(ws.doc.toString()).toContain("[modules.agent]\nenabled = false\n");
    ws.save();
    const saved = read("miyoria.toml");
    expect(saved).toContain('password = "${OBS_PASSWORD:-}"'); // secret reference untouched
    expect(saved).toContain("port = 4456\n");
  });

  it("set_writes_references_to_env_and_values_to_toml", async () => {
    writeFileSync(join(dir, ".env"), "LLM_API_KEY=old\n");
    await config.set(
      path,
      ["llm.providers.deepseek.api_key", "sk-new-1234567890"],
      undefined,
      false,
    );
    expect(read(".env")).toBe("LLM_API_KEY=sk-new-1234567890\n");
    expect(text()).toContain("引用 ${LLM_API_KEY},改寫 .env 的 LLM_API_KEY");
    expect(text()).not.toContain("sk-new-1234567890");

    await config.set(path, ["core.log", "debug"], undefined, false);
    expect(read("miyoria.toml")).toContain('log = "debug"\n');
    await config.set(path, ["stage.obs.port", "4460"], undefined, false);
    expect(read("miyoria.toml")).toContain("port = 4460\n");

    // A new plain secret goes to .env behind a reference.
    await config.set(path, ['modules."platform.x".api_key', "secret-value-123"], undefined, false);
    expect(read("miyoria.toml")).toContain(
      '[modules."platform.x"]\napi_key = "${PLATFORM_X_API_KEY:-}"\n',
    );
    expect(read(".env")).toContain("PLATFORM_X_API_KEY=secret-value-123\n");

    await expect(config.set(path, ["stage.obs.port", "abc"], undefined, false)).rejects.toThrow(
      /port/,
    );
    await expect(config.set(path, ["llm.providers", "x"], undefined, false)).rejects.toThrow(
      /是表格/,
    );
    await expect(config.set(path, ["x"], "1BAD", false)).rejects.toThrow(/不是合法的環境變數名稱/);
  });

  it("unset_get_and_list", async () => {
    writeFileSync(join(dir, ".env"), "LLM_API_KEY=sk-1234567890abcd\nUNUSED=1\n");
    config.get(path, "llm.providers.deepseek.api_key", undefined, false);
    expect(text()).toContain("••••abcd");
    expect(text()).toContain("LLM_API_KEY: .env");
    out.length = 0;
    config.list(path, false);
    expect(text()).toContain('core.profile = "deepseek-chan"');
    expect(text()).toContain("UNUSED = 1  (miyoria.toml 沒有引用)");
    expect(text()).not.toContain("sk-1234567890abcd");
    await config.unset(path, "core.log", undefined, false);
    expect(read("miyoria.toml")).not.toContain("log = ");
    await config.unset(path, undefined, "UNUSED", false);
    expect(read(".env")).toBe("LLM_API_KEY=sk-1234567890abcd\n");
    await expect(config.unset(path, "core.nope", undefined, false)).rejects.toThrow(
      /沒有 `core.nope`/,
    );
    expect(() => config.get(path, "nope", undefined, false)).toThrow(/miyoria config list/);
  });

  it("editor_command_parses_arguments", () => {
    expect(config.editorCommand({ EDITOR: "code -w" })).toEqual(["code", ["-w"]]);
    expect(config.editorCommand({ VISUAL: "nvim", EDITOR: "code" })[0]).toBe("nvim");
    expect(config.editorCommand({})[0]).toBe(process.platform === "win32" ? "notepad" : "vi");
  });
});
