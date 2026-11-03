// What her mind is told about singing and about hearing the voice channel.

import { ServiceRegistry } from "@miyoria/kernel";
import { SpeechPauseKey, type VoiceChannelState, VoiceFloorKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { singing, voiceTalk } from "../src/snapshot.js";

function services(song: { playing: boolean; pending: number } | null, paused: boolean) {
  const s = new ServiceRegistry();
  if (song) {
    s.provide("test", VoiceFloorKey, {
      holder: () => (song.playing ? "song" : null),
      pending: () => song.pending,
    });
  }
  s.provide("test", SpeechPauseKey, { paused: () => (paused ? "song" : null) });
  return s;
}

describe("singing", () => {
  it("tells her a song is playing and how many are left", () => {
    const { note, deaf } = singing(services({ playing: true, pending: 3 }, false), "g1");
    expect(note).toContain("你正在唱歌:語音裡安靜是大家在聽");
    expect(note).toContain("歌單還有 2 首");
    expect(deaf).toBe(false);
  });

  it("tells her she cannot hear voice while a song is prepared", () => {
    const { note, deaf } = singing(services({ playing: false, pending: 1 }, true), "g1");
    expect(note).toContain("歌單還有 1 首");
    expect(note).toContain("你暫時聽不到語音裡的人說話");
    expect(deaf).toBe(true);
  });

  it("says nothing when no song is about and she can hear", () => {
    expect(singing(services({ playing: false, pending: 0 }, false), "g1")).toEqual({
      note: "",
      deaf: false,
    });
    expect(singing(services(null, false), null).note).toBe("");
  });
});

describe("voiceTalk", () => {
  const quiet = {
    activity: { recent_utterances: 0, secs_since_last: null, recent_speakers: [], lively: false },
  } as unknown as VoiceChannelState;

  it("does not call a channel quiet while she cannot hear it", () => {
    expect(voiceTalk(quiet)).toBe(";最近沒人說話");
    expect(voiceTalk(quiet, true)).toBe(";你現在聽不到這裡的人說話");
  });
});
