// `voice` module tests: listening, consent, speaking, barge-in and commands, with a fake voice
// node and fake ASR / TTS providers (port of `tests/voice.rs`).

import {
  type CommandRegistry,
  CommandRegistryKey,
  CommandsModule,
  replyEphemeral,
} from "@miyoria/commands";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type Subscription,
} from "@miyoria/kernel";
import { type ChatRequest, type LlmRouter, LlmRouterKey } from "@miyoria/llm";
import {
  type AsrHint,
  type AsrProvider,
  type AudioBuf,
  type AudioChunk,
  type AudioStream,
  SpeechService,
  SpeechServiceKey,
  type Transcript,
  type TtsProvider,
  type TtsRequest,
} from "@miyoria/speech";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type JsonObject,
  type JsonValue,
  type PlaybackState,
  VoiceSinkKey,
  type VoiceUtterance,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceModule } from "../src/index.js";
import {
  deepseekVoice,
  Harness,
  type Node,
  nextEvent,
  SELF_ID,
  sleepMs,
  waitUntil,
} from "./harness.js";

const RATE = 16_000;

/** 180 Hz voice-like tone, amplitude-modulated at 4 Hz. */
function voice(ms: number): Int16Array {
  return Int16Array.from({ length: Math.floor((RATE * ms) / 1000) }, (_, i) => {
    const t = i / RATE;
    const w = 2 * Math.PI * 180 * t;
    const carrier = Math.sin(w) * 0.6 + Math.sin(2 * w) * 0.3;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    return Math.trunc(carrier * env * 0.3 * 32767);
  });
}

function utteranceAudio(): Int16Array {
  const v = voice(1200);
  const out = new Int16Array(RATE / 5 + v.length + RATE);
  out.set(v, RATE / 5);
  return out;
}

class FakeAsr implements AsrProvider {
  readonly name = "fake-asr";
  text = "";
  calls: Array<[number, AsrHint]> = [];

  async transcribe(audio: AudioBuf, hint: AsrHint): Promise<Transcript> {
    expect(audio.sampleRate).toBe(16_000);
    this.calls.push([audio.samples.length, { ...hint }]);
    return { text: this.text, language: "zh", emotion: "happy", audio_events: ["laughter"] };
  }
}

class FakeTts implements TtsProvider {
  readonly name = "fake-tts";
  requests: TtsRequest[] = [];
  /** Keep the stream open after the audio (a long generation). */
  endless = false;

  async synthesize(request: TtsRequest): Promise<AudioStream> {
    this.requests.push(request);
    const endless = this.endless;
    const chunks: AudioChunk[] = [
      { sampleRate: 24_000, samples: new Int16Array(0) },
      { sampleRate: 24_000, samples: new Int16Array(2400).fill(100) },
      { sampleRate: 24_000, samples: new Int16Array(2400).fill(-100) },
    ];
    return (async function* () {
      yield* chunks;
      if (endless) await new Promise(() => undefined);
    })();
  }
}

/** Stands in for the `speech` module. */
class FakeSpeech implements Module {
  readonly manifest = defineManifest("speech", "Fake speech");

  constructor(
    readonly asr: FakeAsr,
    readonly tts: FakeTts,
  ) {}

  async start(ctx: ModuleContext): Promise<void> {
    ctx.provide(SpeechServiceKey, new SpeechService([this.asr], [this.tts]));
  }
}

const voiceCtx: ContextKey = { platform: "discord", scope: "g1", channel: "vc1", kind: "voice" };

function account(id: string): AccountRef {
  return { platform: "discord", id };
}

class Env {
  constructor(
    readonly h: Harness,
    readonly asr: FakeAsr,
    readonly tts: FakeTts,
    readonly settings: MemorySettingsStore,
    readonly node: Node,
    readonly module: VoiceModule,
  ) {}

  speakStream(stream: number, user: string, audio: Int16Array): void {
    this.node.sendJson({
      type: "stream_open",
      stream,
      guild: "g1",
      channel: "vc1",
      user_id: user,
      display_name: `nick-${user}`,
      sample_rate: 16000,
    });
    this.node.sendAudio(stream, audio);
    this.node.sendJson({ type: "stream_close", stream });
  }

  registry(): CommandRegistry {
    return this.h.services.require(CommandRegistryKey);
  }

  async command(
    path: string,
    invoker: string,
    args: Record<string, string> = {},
    guild = "g1",
  ): Promise<{ text: string; ephemeral: boolean }> {
    const reply = await this.registry().dispatch({
      path: path.split(/\s+/),
      args,
      invoker: account(invoker),
      invoker_display_name: invoker,
      context: { platform: "discord", scope: guild, channel: "text1", kind: "channel" },
      // Go Live needs moderator+; guild admins have it.
      invoker_is_guild_admin: invoker.startsWith("admin"),
    });
    const declared = this.registry().get(path.split(/\s+/))?.ephemeral ?? true;
    return { text: reply.text, ephemeral: replyEphemeral(declared, reply) };
  }
}

let env: Env | null = null;

afterEach(async () => {
  await env?.h.stop();
  env = null;
});

async function boot(
  voiceConfig: JsonObject = {},
  router: Pick<LlmRouter, "complete"> | null = null,
): Promise<Env> {
  const asr = new FakeAsr();
  asr.text = "这个游戏好难";
  const tts = new FakeTts();
  const settings = new MemorySettingsStore();
  const module = new VoiceModule("deepseek-chan", deepseekVoice());
  const h = await Harness.start(
    {},
    [
      [new FakeSpeech(asr, tts), null],
      [new CommandsModule(), null],
      [module, voiceConfig as JsonValue],
    ],
    (services) => {
      services.provide("app", SettingsStoreKey, settings);
      if (router) services.provide("app", LlmRouterKey, router as LlmRouter);
    },
  );
  expect(h.moduleState("voice").state).toBe("running");
  const node = await h.node(SELF_ID);
  node.sendJson({
    type: "voice_state",
    guild: "g1",
    channel: "vc1",
    participants: [
      { user_id: "u1", display_name: "小明" },
      { user_id: "u2", display_name: "阿華" },
      { user_id: SELF_ID, display_name: "DeepSeek-chan", is_self: true },
    ],
  });
  node.sendJson({ type: "joined", guild: "g1", channel: "vc1" });
  const link = h.link();
  await waitUntil(() => link.participants("g1").length === 3);
  env = new Env(h, asr, tts, settings, node, module);
  return env;
}

async function nextUtterance(sub: Subscription): Promise<VoiceUtterance> {
  for (;;) {
    const ev = (await nextEvent(sub)).event;
    if (ev.type === "voice_utterance") return ev.data;
  }
}

async function readPlayback(node: Node): Promise<[number, number, number]> {
  const start = await node.recvType("play_start");
  const id = start.play as number;
  const rate = start.sample_rate as number;
  let samples = 0;
  for (;;) {
    const msg = await node.recv();
    if (msg.kind === "binary") samples += (msg.data.length - 5) / 2;
    else if (msg.kind === "text" && msg.text.includes("play_end")) return [id, rate, samples];
    else throw new Error(`unexpected ${msg.kind}`);
  }
}

function finish(node: Node, play: number): void {
  node.sendJson({ type: "playback", play, state: "started" });
  node.sendJson({ type: "playback", play, state: "finished" });
}

describe("voice", () => {
  it("transcribes_utterances", async () => {
    const e = await boot({ asr_prompt: "DeepSeek醬" });
    const events = e.h.subscribe(["voice.utterance", "voice.latency"]);
    e.speakStream(1, "u1", utteranceAudio());

    const u = await nextUtterance(events);
    expect(u.text).toBe("這個遊戲好難");
    expect(u.speaker.account).toEqual(account("u1"));
    expect(u.speaker.display_name).toBe("小明"); // name from participants
    expect(u.context).toEqual(voiceCtx);
    expect(u.language).toBe("zh");
    expect(u.emotion).toBe("happy");
    expect(u.audio_events).toEqual(["laughter"]);
    expect(Date.parse(u.ended_at)).toBeGreaterThan(Date.parse(u.started_at));
    const latency = (await nextEvent(events)).event;
    if (latency.type !== "custom") throw new Error(`unexpected ${latency.type}`);
    expect(latency.data.topic).toBe("voice.latency");
    const payload = latency.data.payload as Record<string, JsonValue>;
    expect(payload.stage).toBe("asr");
    expect(payload.provider).toBe("fake-asr");
    expect(typeof payload.asr_ms).toBe("number");
    expect(e.asr.calls.length).toBe(1);
    // About 0.2 s pre-roll + 1.2 s speech + 0.2 s tail.
    const [len, hint] = e.asr.calls[0] as [number, AsrHint];
    expect(len).toBeGreaterThanOrEqual(RATE);
    expect(len).toBeLessThan(RATE * 2);
    expect(hint.prompt).toBe("DeepSeek醬");
    expect(hint.language).toBeNull();

    // Hallucinations and silence produce nothing.
    e.asr.text = "谢谢观看";
    e.speakStream(2, "u1", utteranceAudio());
    e.speakStream(3, "u1", new Int16Array(RATE * 2));
    await waitUntil(() => e.asr.calls.length === 2);
    e.asr.text = "最后一句";
    e.speakStream(4, "u1", utteranceAudio());
    expect((await nextUtterance(events)).text).toBe("最後一句");
    expect(e.asr.calls.length).toBe(3); // silence never reaches ASR
  });

  it("consent_is_respected", async () => {
    const e = await boot();
    const events = e.h.subscribe(["voice.utterance"]);

    const reply = await e.command("voice consent", "u2", { state: "off" });
    expect(reply.text).toBe("已更新：她在語音頻道中不會聽你說話。");
    expect(reply.ephemeral).toBe(true);
    expect((await e.command("voice consent", "u2")).text).toBe(
      "目前設定：她在語音頻道中不會聽你說話。",
    );
    expect(await e.settings.get("_global", "voice_consent:discord:u2")).toBe(false);

    e.speakStream(1, "u2", utteranceAudio());
    e.speakStream(2, "u1", utteranceAudio());
    expect((await nextUtterance(events)).speaker.account.id).toBe("u1");
    expect(e.asr.calls.length).toBe(1); // u2 never reached ASR

    // Her own account is never transcribed either.
    e.speakStream(3, SELF_ID, utteranceAudio());
    await e.command("voice consent", "u2", { state: "on" });
    e.speakStream(4, "u2", utteranceAudio());
    expect((await nextUtterance(events)).speaker.account.id).toBe("u2");
    expect(e.asr.calls.length).toBe(2);
  });

  it("opt_in_policy_drops_unknown_users", async () => {
    const e = await boot({ consent: "opt-in", to_traditional: false });
    const events = e.h.subscribe(["voice.utterance"]);
    e.speakStream(1, "u1", utteranceAudio());
    await e.command("voice consent", "u2", { state: "on" });
    e.speakStream(2, "u2", utteranceAudio());
    const u = await nextUtterance(events);
    expect(u.speaker.account.id).toBe("u2");
    expect(u.text).toBe("这个游戏好难"); // conversion disabled
    expect(e.asr.calls.length).toBe(1);
  });

  it("speaks_through_tts", async () => {
    const e = await boot();
    const events = e.h.subscribe(["voice.playback", "voice.latency"]);
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(
      voiceCtx,
      "<emo:annoyed>哼,才不是在等你呢。<pause 300/>",
      "annoyed",
      null,
    );
    const [id, rate, samples] = await readPlayback(e.node);
    expect([rate, samples]).toEqual([24_000, 4800]);
    e.node.sendJson({ type: "playback", play: id, state: "started" });
    e.node.sendJson({ type: "playback", play: id, state: "finished" });
    expect(await speaking).toBe("completed");

    const req = e.tts.requests[0] as TtsRequest;
    expect(req.text).toBe("哼,才不是在等你呢。");
    expect(req.language).toBe("Chinese");
    expect(req.emotion).toBe("annoyed");
    expect(req.instruct).toBe("不耐煩、拖長音");
    expect(req.voice).toBe("deepseek-chan");

    const states: PlaybackState[] = [];
    let firstAudio: JsonValue | undefined;
    while (states.length < 2) {
      const ev = (await nextEvent(events)).event;
      if (ev.type === "voice_playback") {
        expect(ev.data.text).toBe("哼,才不是在等你呢。");
        states.push(ev.data.state);
      } else if (ev.type === "custom") {
        const p = ev.data.payload as Record<string, JsonValue>;
        expect(p.stage).toBe("tts");
        firstAudio = p.first_audio_ms;
      } else {
        throw new Error(`unexpected ${ev.type}`);
      }
    }
    expect(states).toEqual(["started", "finished"]);
    expect(typeof firstAudio).toBe("number");

    // Nothing left after stripping tags: nothing to say.
    expect(await sink.speak(voiceCtx, "<silence/>", null, null)).toBe("completed");
    expect(e.tts.requests.length).toBe(1);
  });

  it("barge_in_stops_playback", async () => {
    const e = await boot();
    e.tts.endless = true;
    const events = e.h.subscribe(["voice.playback"]);
    const sink = e.h.services.require(VoiceSinkKey);
    let finished = false;
    const speaking = sink.speak(voiceCtx, "我跟你說喔", null, null).finally(() => {
      finished = true;
    });
    const start = await e.node.recvType("play_start");
    const id = start.play as number;
    const started = (await nextEvent(events)).event;
    expect(started.type === "voice_playback" && started.data.state).toBe("started");

    // A short "嗯" does not interrupt her; talking over her does.
    e.node.sendJson({
      type: "stream_open",
      stream: 9,
      guild: "g1",
      channel: "vc1",
      user_id: "u1",
      display_name: "",
      sample_rate: 16000,
    });
    e.node.sendAudio(9, voice(300));
    e.node.sendAudio(9, new Int16Array(RATE / 2));
    await sleepMs(200);
    expect(finished).toBe(false);
    e.node.sendAudio(9, voice(1000));

    expect(await e.node.recvType("play_stop")).toEqual({
      type: "play_stop",
      play: id,
      fade_ms: 150,
    });
    expect(await speaking).toBe("interrupted");
    const ended = (await nextEvent(events)).event;
    expect(ended.type === "voice_playback" && ended.data.state).toBe("interrupted");
  });

  it("barge_in_can_be_ignored", async () => {
    const e = await boot({ barge_in: "ignore" });
    const sink = e.h.services.require(VoiceSinkKey);
    let finished = false;
    const speaking = sink.speak(voiceCtx, "我跟你說喔", null, null).finally(() => {
      finished = true;
    });
    const [id] = await readPlayback(e.node);
    e.speakStream(9, "u1", utteranceAudio());
    await sleepMs(300);
    expect(finished).toBe(false);
    e.node.sendJson({ type: "playback", play: id, state: "finished" });
    expect(await speaking).toBe("completed");
  });

  it("join_and_leave_commands", async () => {
    const e = await boot();
    const registry = e.registry();
    expect(registry.get(["voice", "join"])).toBeDefined();
    expect(registry.groupInfo(["voice"])?.guild_only).toBe(true);

    const gate = e.h.sup.bus.subscribe("gate.decision");
    const joining = e.command("voice join", "u7", {}, "g2");
    expect(await e.node.recvType("join")).toEqual({ type: "join", guild: "g2", user_id: "u7" });
    e.node.sendJson({ type: "joined", guild: "g2", channel: "vc2" });
    const reply = await joining;
    expect(reply.ephemeral).toBe(false);
    expect(reply.text).toContain("/voice consent off");
    // The command went through the gate as an overriding `command` principal.
    const decision = gate.tryRecv()?.event;
    expect(decision?.type === "custom" && decision.data.payload).toMatchObject({
      capability: "voice.join",
      allowed: true,
      principal: { kind: "command", requester: { id: "u7" }, override: true },
    });

    const left = await e.command("voice leave", "u7");
    expect(left.text).toBe("她已離開語音頻道。");
    expect((await e.node.recvType("leave")).guild).toBe("g1");

    // Stopping the module removes its commands.
    await e.h.sup.disable("voice");
    expect(registry.get(["voice", "join"])).toBeUndefined();
    expect(registry.get(["voice", "consent"])).toBeUndefined();
  });

  it("golive_commands", async () => {
    const e = await boot();
    const registry = e.registry();
    expect(registry.get(["voice", "golive", "start"])).toBeDefined();
    expect(registry.groupDescription(["voice", "golive"])).toContain("Go Live");
    // Plain users may look, not start.
    expect((await e.command("voice golive start", "u7")).text).toContain("voice.golive");

    // Not in a voice channel: joins the invoker's channel first, then goes live.
    const joining = e.command("voice golive start", "admin7", {}, "g2");
    expect(await e.node.recvType("join")).toEqual({
      type: "join",
      guild: "g2",
      user_id: "admin7",
    });
    e.node.sendJson({ type: "joined", guild: "g2", channel: "vc2" });
    expect((await e.node.recvType("golive_start")).guild).toBe("g2");
    const joined = await joining;
    expect(joined.ephemeral).toBe(false);
    expect(joined.text).toContain("/voice consent off");
    expect(joined.text).toContain("已開始 Go Live");

    const starting = e.command("voice golive start", "admin7");
    const req = await e.node.recvType("golive_start");
    expect(req.guild).toBe("g1");
    expect(req.source).toBe("rtmp://127.0.0.1:1935/live/miyoria");
    expect((await starting).text).toContain("已開始 Go Live");

    // The node reports progress; `/golive status` mirrors it.
    e.node.sendJson({ type: "golive", guild: "g1", state: "live" });
    await waitUntil(() => e.h.link().golive("g1")?.state === "live");
    const live = await e.command("voice golive status", "u7");
    expect(live.ephemeral).toBe(true);
    expect(live.text).toContain("直播中");

    // A second start is refused while it runs.
    expect((await e.command("voice golive start", "admin7")).text).toContain("已經在進行中");

    const stopping = e.command("voice golive stop", "admin7");
    expect((await e.node.recvType("golive_stop")).guild).toBe("g1");
    e.node.sendJson({ type: "golive", guild: "g1", state: "stopped", reason: "stop requested" });
    await waitUntil(() => e.h.link().golive("g1")?.state === "stopped");
    expect((await stopping).text).toBe("已結束 Go Live。");
    expect((await e.command("voice golive status", "u7")).text).toContain("未直播");
  });

  it("golive_start_takes_a_source_override", async () => {
    const e = await boot();
    const starting = e.command("voice golive start", "admin7", { source: "srt://127.0.0.1:9999" });
    expect((await e.node.recvType("golive_start")).source).toBe("srt://127.0.0.1:9999");
    await starting;
  });

  // ── TS-specific ─────────────────────────────────────────────────────────────

  it("tts_translate_speaks_the_translation_and_keeps_the_original_for_subtitles", async () => {
    const asked: ChatRequest[] = [];
    const router = {
      async complete(purpose: string, request: ChatRequest) {
        expect(purpose).toBe("fast");
        asked.push(request);
        const line = request.messages.at(-1)?.content;
        if (line === "壞掉") throw new Error("model down");
        return { text: ` ja(${String(line)}) ` } as never;
      },
    };
    const e = await boot({ tts_translate: "Japanese" }, router);
    const events = e.h.subscribe(["voice.playback"]);
    const sink = e.h.services.require(VoiceSinkKey);

    // Prepared early (when the agent queues the sentence), spoken later: translated once.
    sink.prepare?.(voiceCtx, "<emo:happy>你好啊");
    const speaking = sink.speak(voiceCtx, "<emo:happy>你好啊", "happy", null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await speaking).toBe("completed");
    expect(asked.length).toBe(1);
    expect(asked[0]?.thinking).toBe(false);
    expect(e.tts.requests[0]).toMatchObject({ text: "ja(你好啊)", language: "Japanese" });
    const started = (await nextEvent(events)).event;
    expect(started.type === "voice_playback" && started.data.text).toBe("你好啊");

    // A failed translation still speaks, untranslated.
    const fallback = sink.speak(voiceCtx, "壞掉", null, null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await fallback).toBe("completed");
    expect(e.tts.requests[1]?.text).toBe("壞掉");
  });

  it("a_spoken_line_from_the_reply_is_said_without_a_translation_call", async () => {
    const asked: ChatRequest[] = [];
    const router = {
      async complete(_purpose: string, request: ChatRequest) {
        asked.push(request);
        return { text: "ja(?)" } as never;
      },
    };
    const e = await boot({ tts_translate: "Japanese" }, router);
    const sink = e.h.services.require(VoiceSinkKey);
    expect(sink.speaksIn).toBe("Japanese");
    sink.prepare?.(voiceCtx, "真的嗎?", "えっ、本当に?");
    const speaking = sink.speak(voiceCtx, "真的嗎?", null, null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await speaking).toBe("completed");
    expect(asked.length).toBe(0);
    expect(e.tts.requests[0]).toMatchObject({ text: "えっ、本当に?", language: "Japanese" });

    // A "Japanese" line without kana is Chinese after all: translated instead.
    sink.prepare?.(voiceCtx, "苦力怕好討厭", "苦力怕真的很討厭");
    const second = sink.speak(voiceCtx, "苦力怕好討厭", null, null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await second).toBe("completed");
    expect(asked.length).toBe(1);
    expect(e.tts.requests[1]?.text).toBe("ja(?)");

    // Written in Japanese already: said as it is, no call.
    const third = sink.speak(voiceCtx, "もう、邪魔しないでよ!", null, null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await third).toBe("completed");
    expect(asked.length).toBe(1);
    expect(e.tts.requests[2]?.text).toBe("もう、邪魔しないでよ!");
  });

  it("speak_signal_abort_stops_playback", async () => {
    const e = await boot();
    e.tts.endless = true;
    const sink = e.h.services.require(VoiceSinkKey);
    const controller = new AbortController();
    const speaking = sink.speak(voiceCtx, "說很久", null, null, controller.signal);
    const start = await e.node.recvType("play_start");
    controller.abort(new Error("timed out"));
    await expect(speaking).rejects.toThrow("timed out");
    expect(await e.node.recvType("play_stop")).toEqual({
      type: "play_stop",
      play: start.play as number,
      fade_ms: 0,
    });
  });

  it("health_reports_a_missing_node", async () => {
    const e = await boot();
    expect(await e.module.health()).toEqual({ status: "healthy" });
    e.node.drop();
    await waitUntil(() => !e.h.link().isConnected());
    expect(await e.module.health()).toEqual({
      status: "degraded",
      reason: "voice node not connected",
    });
  });
});
