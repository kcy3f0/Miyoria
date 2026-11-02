// Ports of the Rust unit tests (`#[cfg(test)]` modules of protocol, avatar, emotion, motion,
// lipsync and link::forward), plus TS-specific shape and config checks.

import { fileURLToPath } from "node:url";
import type { ContextKey, ContextKind, Event, PlaybackState } from "@miyoria/types";
import { customEvent, newId } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  AvatarProfile,
  type CoreMessage,
  checkHello,
  defaultLipSyncConfig,
  EMOTION_TOPIC,
  EmotionController,
  Envelope,
  encodeMessage,
  Forwarder,
  GazeConfigSchema,
  goliveFollow,
  IdleMotion,
  Levels,
  type LipSyncConfig,
  MouthShaper,
  parseAvatarAction,
  parseCoreMessage,
  parseGazeTarget,
  parseLevelFrame,
  parseStageConfig,
  parseStageMessage,
  StageLinkConfigSchema,
  type StageMessage,
  tokenMatches,
  VOICE_GOLIVE_TOPIC,
  type VtsCommand,
} from "../src/index.js";

describe("protocol", () => {
  it("core_messages_match_the_spec", () => {
    const cases: [CoreMessage, unknown][] = [
      [
        { type: "emotion", name: "happy", intensity: 1.0 },
        { type: "emotion", name: "happy", intensity: 1.0 },
      ],
      [
        { type: "subtitle", turn: "t1", text: "早安", final: true },
        { type: "subtitle", turn: "t1", text: "早安", final: true },
      ],
      [
        { type: "speaking", state: "started" },
        { type: "speaking", state: "started" },
      ],
      [
        { type: "scene", name: "Game", id: 3 },
        { type: "scene", name: "Game", id: 3 },
      ],
      [
        { type: "stream", action: "stop" },
        { type: "stream", action: "stop" },
      ],
      [
        { type: "avatar_hotkey", name: "Wave" },
        { type: "avatar_hotkey", name: "Wave" },
      ],
      [
        { type: "gaze", target: "chat" },
        { type: "gaze", target: "chat" },
      ],
    ];
    for (const [msg, expected] of cases) {
      expect(JSON.parse(encodeMessage(msg))).toStrictEqual(expected);
      expect(parseCoreMessage(expected)).toStrictEqual(msg);
    }
  });

  it("stage_status_is_flat", () => {
    const msg: StageMessage = {
      type: "status",
      vts: true,
      obs: false,
      scene: "Talk",
      streaming: false,
      id: 7,
    };
    expect(JSON.parse(encodeMessage(msg))).toStrictEqual({
      type: "status",
      vts: true,
      obs: false,
      scene: "Talk",
      streaming: false,
      id: 7,
    });
    expect(parseStageMessage({ type: "status", vts: false, obs: true })).toStrictEqual({
      type: "status",
      vts: false,
      obs: true,
      scene: null,
      streaming: false,
    });
  });

  it("level_frames", () => {
    const f = parseLevelFrame(JSON.parse(`{"t": 120, "rms": 0.25}`));
    expect(f.t).toBe(120);
    expect(f.rms).toBe(0.25);
    expect(parseLevelFrame({ rms: 0.5 }).t).toBe(0);
    expect(() => parseLevelFrame({ t: 1 })).toThrow();
  });

  it("unknown_fields_are_ignored_and_bad_messages_rejected", () => {
    expect(parseCoreMessage({ type: "ping", extra: 1 })).toStrictEqual({ type: "ping" });
    expect(parseStageMessage({ type: "error", message: "x", id: null })).toStrictEqual({
      type: "error",
      message: "x",
    });
    expect(() => parseCoreMessage({ type: "nope" })).toThrow();
    expect(() => parseCoreMessage({ type: "gaze", target: "floor" })).toThrow();
    expect(parseGazeTarget(" Chat ")).toBe("chat");
    expect(parseGazeTarget("floor")).toBeNull();
  });

  it("hello_validation", () => {
    const hello = (v: unknown) => checkHello(JSON.stringify(v), "secret");
    expect(checkHello("not json", "secret")).toMatchObject({ ok: false, code: 4400 });
    expect(hello({ type: "status" })).toMatchObject({ ok: false, code: 4400 });
    expect(hello({ type: "hello", version: 1, token: "nope" })).toMatchObject({
      ok: false,
      code: 4401,
    });
    expect(hello({ type: "hello", version: 9, token: "secret" })).toMatchObject({
      ok: false,
      code: 4400,
      reason: "unsupported version",
    });
    expect(hello({ type: "hello", version: 1, token: "secret" })).toStrictEqual({
      ok: true,
      node: "",
      capabilities: [],
    });
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
  });
});

describe("config", () => {
  it("defaults_match_legacy", () => {
    expect(StageLinkConfigSchema.parse({})).toStrictEqual({
      bind: "127.0.0.1:7882",
      token: "",
      ping_interval_ms: 15_000,
      peer_timeout_ms: 45_000,
      hello_timeout_ms: 5_000,
      request_timeout_ms: 10_000,
      subtitle_text_turns: false,
      golive_obs: true,
      golive_start_delay_ms: 3_000,
    });
    const c = parseStageConfig({ vts: { inject_hz: 30 }, gaze: { chat: { face_x: 1 } } });
    expect(c.core_url).toBe("ws://127.0.0.1:7882/stage-link");
    expect(c.node).toBe("stage");
    expect(c.data_dir).toBe("data/stage");
    expect(c.overlay_bind).toBe("127.0.0.1:7884");
    expect(c.overlay_dir).toBe("apps/overlay/dist");
    expect(c.peer_timeout_ms).toBe(45_000);
    expect(c.vts).toMatchObject({
      enabled: true,
      url: "ws://127.0.0.1:8001",
      plugin_name: "Miyoria",
      plugin_developer: "Miyoria",
      plugin_icon: null,
      emotion_hold_ms: 4_000,
      after_speech_ms: 1_500,
      expression_fade: 0.3,
      inject_hz: 30,
      face_found: false,
      idle_motion: true,
      request_timeout_ms: 5_000,
      approval_timeout_ms: 120_000,
    });
    expect(c.obs).toStrictEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4455,
      password: "",
      subtitle_source: null,
      subtitle_clear_ms: 6_000,
      poll_ms: 2_000,
      stream_wait_ms: 15_000,
    });
    expect(c.lipsync).toStrictEqual(defaultLipSyncConfig());
    expect(c.lipsync.bind).toBe("127.0.0.1:7883");
    // A partial pose keeps zero for the rest; a missing one keeps its default.
    expect(c.gaze.chat).toStrictEqual({ face_x: 1, face_y: 0, face_z: 0, eye_x: 0, eye_y: 0 });
    expect(c.gaze.game).toStrictEqual({
      face_x: 8,
      face_y: -10,
      face_z: 0,
      eye_x: 0.3,
      eye_y: -0.5,
    });
    expect(c.gaze.idle_amount).toBe(1);
    expect(c.gaze.turn_ms).toBe(600);
    expect(c.avatar).toStrictEqual(new AvatarProfile());
  });
});

describe("avatar", () => {
  it("parses_the_deepseek_chan_avatar", () => {
    const path = fileURLToPath(
      new URL("../../../profiles/deepseek-chan/avatar.toml", import.meta.url),
    );
    const p = AvatarProfile.load(path);
    expect(p.vtsModel).toBe("大肥鱼");
    // Every emotion but `neutral` (the resting state) maps to one of the model's expressions.
    expect(p.emotions.size).toBe(8);
    expect([...p.emotions.values()].every((a) => JSON.stringify(a).includes(".exp3.json"))).toBe(
      true,
    );
    expect(p.lipsync).toBe("inject");
    expect(p.mouthOpen).toBe("MouthOpen");
    expect(p.mouthForm).toBe("MouthSmile");
  });

  it("maps_expressions_and_hotkeys", () => {
    const p = AvatarProfile.parse({
      vts_model: "DeepSeek-chan",
      emotion: { neutral: "Reset", Happy: "smile.EXP3.json", smug: "Smug Face", sad: "" },
      lipsync: { mode: "mic", mouth_form: "" },
    });
    expect(p.vtsModel).toBe("DeepSeek-chan");
    expect(p.actionFor("happy")).toStrictEqual({ type: "expression", file: "smile.EXP3.json" });
    expect(p.actionFor("Smug")).toStrictEqual({ type: "hotkey", name: "Smug Face" });
    expect(p.actionFor("neutral")).toStrictEqual({ type: "hotkey", name: "Reset" });
    expect(p.actionFor("sad")).toBeNull();
    expect(p.lipsync).toBe("mic");
    expect(p.mouthForm).toBeNull();
    expect([...p.emotions.keys()]).toStrictEqual(["happy", "neutral", "smug"]);
    expect(AvatarProfile.parse(null)).toStrictEqual(new AvatarProfile());
    expect(() => AvatarProfile.parse({ lipsync: { mode: "puppet" } })).toThrow(/avatar\.toml/);
  });
});

describe("emotion", () => {
  function profile(entries: [string, string][]): AvatarProfile {
    const p = new AvatarProfile();
    for (const [k, v] of entries) {
      const a = parseAvatarAction(v);
      if (a) p.emotions.set(k, a);
    }
    return p;
  }
  const expr = (file: string, active: boolean): VtsCommand => ({
    type: "expression",
    file,
    active,
  });
  const hotkey = (name: string): VtsCommand => ({ type: "hotkey", name });
  const HOLD = 4_000;
  const AFTER = 1_000;

  it("expression_is_held_then_reverts", () => {
    const p = profile([
      ["happy", "happy.exp3.json"],
      ["sad", "sad.exp3.json"],
    ]);
    const c = new EmotionController(p, HOLD, AFTER);
    const t0 = 1_000_000;
    expect(c.rest()).toStrictEqual([]);
    expect(c.onEmotion("Happy", t0)).toStrictEqual([expr("happy.exp3.json", true)]);
    expect(c.current()).toBe("happy");
    // Repeating extends the hold without new requests.
    expect(c.onEmotion("happy", t0 + 2_000)).toStrictEqual([]);
    expect(c.tick(t0 + HOLD)).toStrictEqual([]);
    expect(c.tick(t0 + 6_000)).toStrictEqual([expr("happy.exp3.json", false)]);
    expect(c.current()).toBeNull();
    // One main expression: switching deactivates the old one first.
    c.onEmotion("happy", t0);
    expect(c.onEmotion("sad", t0)).toStrictEqual([
      expr("happy.exp3.json", false),
      expr("sad.exp3.json", true),
    ]);
    // Neutral and unmapped emotions return to rest at once.
    expect(c.onEmotion("neutral", t0)).toStrictEqual([expr("sad.exp3.json", false)]);
    c.onEmotion("sad", t0);
    expect(c.onEmotion("thinking", t0)).toStrictEqual([expr("sad.exp3.json", false)]);
    expect(c.onEmotion("thinking", t0)).toStrictEqual([]);
  });

  it("speaking_keeps_the_expression", () => {
    const c = new EmotionController(profile([["happy", "happy.exp3.json"]]), HOLD, AFTER);
    const t0 = 0;
    c.onEmotion("happy", t0);
    c.setSpeaking(true, t0);
    expect(c.tick(t0 + 10_000)).toStrictEqual([]);
    c.setSpeaking(false, t0 + 10_000);
    expect(c.tick(t0 + 10_500)).toStrictEqual([]);
    expect(c.tick(t0 + 11_000)).toStrictEqual([expr("happy.exp3.json", false)]);
  });

  it("hotkeys_and_neutral_rest", () => {
    let c = new EmotionController(
      profile([
        ["neutral", "Clear"],
        ["smug", "Smug"],
        ["happy", "happy.exp3.json"],
      ]),
      HOLD,
      AFTER,
    );
    const t0 = 0;
    expect(c.rest()).toStrictEqual([hotkey("Clear")]);
    expect(c.onEmotion("smug", t0)).toStrictEqual([hotkey("Smug")]);
    expect(c.onEmotion("happy", t0)).toStrictEqual([
      hotkey("Clear"),
      expr("happy.exp3.json", true),
    ]);
    expect(c.tick(t0 + HOLD)).toStrictEqual([expr("happy.exp3.json", false), hotkey("Clear")]);

    // A neutral expression is active while resting.
    c = new EmotionController(
      profile([
        ["neutral", "calm.exp3.json"],
        ["happy", "happy.exp3.json"],
      ]),
      HOLD,
      AFTER,
    );
    expect(c.rest()).toStrictEqual([expr("calm.exp3.json", true)]);
    expect(c.onEmotion("happy", t0)).toStrictEqual([
      expr("calm.exp3.json", false),
      expr("happy.exp3.json", true),
    ]);
    expect(c.onEmotion("neutral", t0)).toStrictEqual([
      expr("happy.exp3.json", false),
      expr("calm.exp3.json", true),
    ]);
  });
});

describe("motion", () => {
  const TICK = 16.667;

  it("turns_towards_the_target_and_stays_gentle", () => {
    const m = new IdleMotion(GazeConfigSchema.parse({}));
    let maxDx = 0;
    let prev = m.update(TICK);
    for (let i = 0; i < 600; i++) {
      const v = m.update(TICK);
      expect(Math.abs(v[0] as number)).toBeLessThanOrEqual(30);
      expect(Math.abs(v[3] as number)).toBeLessThanOrEqual(1);
      maxDx = Math.max(maxDx, Math.abs((v[0] as number) - (prev[0] as number)));
      prev = v;
    }
    expect(maxDx, "smooth").toBeLessThan(0.5);
    expect(Math.abs(prev[0] as number), "near the camera pose").toBeLessThan(5);

    m.setTarget("chat");
    for (let i = 0; i < 240; i++) prev = m.update(TICK);
    // Within the noise of the chat pose.
    expect(Math.abs((prev[0] as number) - -12)).toBeLessThan(5);
    expect(Math.abs((prev[3] as number) - -0.6)).toBeLessThan(0.2);
    expect(prev[3]).toBe(prev[5]);

    const still = new IdleMotion(GazeConfigSchema.parse({ idle_amount: 0 }));
    expect(still.update(TICK)).toStrictEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("lipsync", () => {
  const TICK = 16.667;
  const config = (over: Partial<LipSyncConfig> = {}): LipSyncConfig => ({
    ...defaultLipSyncConfig(),
    ...over,
  });

  it("gate_and_gain", () => {
    const e = new Envelope(config());
    expect(e.target(0)).toBe(0);
    expect(e.target(0.01)).toBe(0);
    expect(Math.abs(e.target(0.115) - 0.5)).toBeLessThan(1e-5);
    expect(e.target(0.9)).toBe(1);
    expect(e.target(Number.NaN)).toBe(0);
  });

  it("attack_is_faster_than_release", () => {
    const e = new Envelope(config());
    // One attack time constant reaches ~63% of the target.
    let v = 0;
    for (let i = 0; i < 2; i++) v = e.update(0.5, 17.5);
    expect(Math.abs(v - (1 - Math.exp(-1)))).toBeLessThan(0.01);
    for (let i = 0; i < 30; i++) e.update(0.5, TICK);
    expect(e.value()).toBeGreaterThan(0.99);
    // After one attack time constant of silence the mouth is still mostly open.
    v = e.update(0, 35);
    expect(v).toBeGreaterThan(0.7);
    for (let i = 0; i < 60; i++) e.update(0, TICK);
    expect(e.value(), "fully closed after silence").toBe(0);
  });

  it("mouth_form_varies_only_while_open", () => {
    const m = new MouthShaper(config());
    const forms: number[] = [];
    for (let i = 0; i < 120; i++) {
      const mouth = m.update(0.15, TICK);
      expect(mouth.open).toBeGreaterThanOrEqual(0);
      expect(mouth.open).toBeLessThanOrEqual(1);
      // VTS `MouthSmile` range.
      expect(mouth.form).toBeGreaterThanOrEqual(0);
      expect(mouth.form).toBeLessThanOrEqual(1);
      forms.push(mouth.form);
    }
    const min = Math.min(...forms);
    const max = Math.max(...forms);
    expect(max - min, "form varies").toBeGreaterThan(0.05);
    expect(max - min).toBeLessThanOrEqual(0.36);
    for (let i = 0; i < 120; i++) m.update(0, TICK);
    // At rest the mouth goes back to neutral (0.5).
    expect(m.update(0, TICK)).toStrictEqual({ open: 0, form: 0.5 });
    expect(m.reset()).toStrictEqual({ open: 0, form: 0.5 });
  });

  it("levels_go_stale_and_respect_latency", () => {
    const t0 = 50_000;
    const levels = new Levels(config());
    expect(levels.current(t0)).toBe(0);
    levels.push(0.3, t0);
    levels.push(0.4, t0 + 10);
    expect(levels.current(t0 + 5)).toBe(0.3);
    expect(levels.current(t0 + 20)).toBe(0.4);
    expect(levels.current(t0 + 150)).toBe(0.4);
    expect(levels.current(t0 + 200)).toBe(0);
    levels.push(2.0, t0);
    expect(levels.current(t0 + 201)).toBe(0);
    levels.clear();

    const delayed = new Levels(config({ latency_ms: 100 }));
    delayed.push(0.5, t0);
    expect(delayed.current(t0 + 50)).toBe(0);
    expect(delayed.current(t0 + 100)).toBe(0.5);
    delayed.push(0.7, t0 + 100);
    delayed.clear();
    expect(delayed.current(t0 + 300)).toBe(0);
  });
});

describe("forward", () => {
  const ctx = (kind: ContextKind): ContextKey => ({
    platform: "discord",
    scope: "g",
    channel: "c",
    kind,
  });
  const playback = (turn: string, state: PlaybackState, text: string): Event => ({
    type: "voice_playback",
    data: { context: ctx("voice"), turn, state, text },
  });
  const completed = (turn: string, kind: ContextKind, text: string): Event => ({
    type: "agent_turn_completed",
    data: { turn, context: ctx(kind), text },
  });
  const subs = (msgs: CoreMessage[]): [string, boolean][] =>
    msgs.flatMap((m) => (m.type === "subtitle" ? [[m.text, m.final] as [string, boolean]] : []));

  it("emotions", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(customEvent(EMOTION_TOPIC, { turn: "x", emotion: " Happy " }))).toStrictEqual([
      { type: "emotion", name: "happy", intensity: 1 },
    ]);
    expect(f.onEvent(customEvent(EMOTION_TOPIC, { emotion: "sad", intensity: 0.4 }))).toStrictEqual(
      [{ type: "emotion", name: "sad", intensity: 0.4 }],
    );
    expect(f.onEvent(customEvent(EMOTION_TOPIC, {}))).toStrictEqual([]);
    expect(f.onEvent(customEvent(EMOTION_TOPIC, { name: "Smug", intensity: 7 }))).toStrictEqual([
      { type: "emotion", name: "smug", intensity: 1 },
    ]);
    expect(f.onEvent(customEvent("other", { emotion: "sad" }))).toStrictEqual([]);
  });

  it("voice_turn_subtitles_follow_playback", () => {
    const f = new Forwarder(false);
    const turn = newId();
    let out = f.onEvent(playback(turn, "started", "哼,"));
    expect(out[0]).toStrictEqual({ type: "speaking", state: "started" });
    expect(subs(out)).toStrictEqual([["哼,", false]]);
    out = f.onEvent(playback(turn, "finished", "哼,"));
    expect(subs(out)).toStrictEqual([]);
    out = f.onEvent(playback(turn, "started", "才不是在等你呢。"));
    expect(subs(out)).toStrictEqual([["哼,才不是在等你呢。", false]]);
    // Completion while speaking: final comes when the playback ends.
    out = f.onEvent(completed(turn, "voice", "哼,才不是在等你呢。"));
    expect(out).toStrictEqual([]);
    out = f.onEvent(playback(turn, "interrupted", ""));
    expect(out[0]).toStrictEqual({ type: "speaking", state: "stopped" });
    expect(subs(out)).toStrictEqual([["哼,才不是在等你呢。", true]]);
  });

  it("completion_after_speech_finalizes_immediately", () => {
    const f = new Forwarder(false);
    const turn = newId();
    f.onEvent(playback(turn, "started", "Hello"));
    f.onEvent(playback(turn, "finished", "Hello"));
    f.onEvent(playback(turn, "started", "there."));
    f.onEvent(playback(turn, "finished", "there."));
    expect(subs(f.onEvent(completed(turn, "voice", "Hello there.")))).toStrictEqual([
      ["Hello there.", true],
    ]);
  });

  it("text_turns_are_optional", () => {
    const turn = newId();
    const done = completed(turn, "channel", "早安");
    expect(new Forwarder(false).onEvent(done)).toStrictEqual([]);
    expect(subs(new Forwarder(true).onEvent(done))).toStrictEqual([["早安", true]]);
    // A failed TTS start does not count as a running playback.
    const f = new Forwarder(false);
    f.onEvent(playback(turn, "started", "a"));
    f.onEvent(playback(turn, "failed", "b"));
    expect(subs(f.onEvent(completed(turn, "voice", "a b")))).toStrictEqual([["a", true]]);
  });

  it("playback_without_turn", () => {
    const f = new Forwarder(false);
    const event = (state: PlaybackState, text: string): Event => ({
      type: "voice_playback",
      data: { context: ctx("voice"), turn: null, state, text },
    });
    expect(f.onEvent(event("started", " hi "))).toStrictEqual([
      { type: "speaking", state: "started" },
      { type: "subtitle", turn: "", text: "hi", final: false },
    ]);
    expect(f.onEvent(event("finished", "hi"))).toStrictEqual([
      { type: "speaking", state: "stopped" },
      { type: "subtitle", turn: "", text: "hi", final: true },
    ]);
    expect(f.onEvent(event("failed", "hi"))).toStrictEqual([
      { type: "speaking", state: "stopped" },
    ]);
  });
});

describe("go live follow", () => {
  it("maps_states_to_obs_actions", () => {
    expect(VOICE_GOLIVE_TOPIC).toBe("voice.golive");
    expect(goliveFollow("starting")).toBe("start");
    expect(goliveFollow("live")).toBeNull();
    expect(goliveFollow("stopped")).toBe("stop");
    expect(goliveFollow("failed")).toBe("stop");
    expect(goliveFollow(undefined)).toBeNull();
    expect(goliveFollow("nonsense")).toBeNull();
  });

  it("config_defaults_follow_go_live", () => {
    const config = StageLinkConfigSchema.parse({ token: "x" });
    expect(config.golive_obs).toBe(true);
    expect(config.golive_start_delay_ms).toBe(3_000);
  });
});
