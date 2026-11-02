import { CommandsModule } from "@miyoria/commands";
import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  customEvent,
  type JsonValue,
  PRESENCE_TOPIC,
  PresencePrivacyKey,
  PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  SocialSignalsKey,
  toTimestamp,
  VOICE_STATE_TOPIC,
  WorldStateKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldModule } from "../src/index.js";
import { acct, FakeSocial, playing, presence, textCtx, voice } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function boot(store = new MemorySettingsStore(), config: JsonValue = { coalesce_ms: 0 }) {
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  const social = new FakeSocial().set("1", 70);
  const contributors = new PromptContributors();
  sup.services.provide("app", SettingsStoreKey, store);
  sup.services.provide("app", SocialSignalsKey, social);
  sup.services.provide("app", PromptContributorsKey, contributors);
  await sup.register(new CommandsModule(), null, true);
  await sup.register(
    new WorldModule({ interests: ["Minecraft"], game: () => "Minecraft" }),
    config,
    true,
  );
  await sup.startAll();
  const salient = sup.bus.subscribe("world.salient");
  const world = sup.services.require(WorldStateKey);
  const publish = (topic: string, payload: object) =>
    sup.bus.publish("test", customEvent(topic, payload as unknown as JsonValue));
  return { sup, store, social, contributors, salient, world, publish };
}

const request = (context = textCtx("c1")): PromptRequest => ({
  profile: "p",
  turn: "t",
  context,
  participants: [],
  speakers: [],
  query: "",
  recent: [],
  voice: false,
  now: toTimestamp(Date.now()),
});

describe("world module", () => {
  it("follows presence and voice from the bus and publishes salient changes", async () => {
    const h = await boot();
    h.publish(PRESENCE_TOPIC, presence("1", "online", [], { initial: true }));
    h.publish(PRESENCE_TOPIC, presence("1", "online", [playing("Minecraft")]));
    h.publish(VOICE_STATE_TOPIC, voice("1", "v1"));
    // Not a valid payload: ignored.
    h.publish(PRESENCE_TOPIC, { account: "nope" });

    const kinds: string[] = [];
    await vi.waitFor(() => {
      for (let env = h.salient.tryRecv(); env; env = h.salient.tryRecv()) {
        if (env.event.type === "custom") {
          kinds.push(String((env.event.data.payload as { kind: string }).kind));
        }
      }
      expect(kinds).toEqual(["started_game", "joined_voice"]);
    });
    const p = h.world.person(acct("1"));
    expect(p).toMatchObject({ status: "online", person: "person-1" });
    expect(h.world.personById("person-1")?.voice?.channel).toBe("v1");
    expect(h.world.snapshot().her.game).toBe("Minecraft");

    const [contributor] = h.contributors.all();
    if (!contributor) throw new Error("no world prompt contributor");
    const [section] = await contributor.contribute(request());
    expect(section?.key).toBe("world");
    expect(section?.body).toContain("user1(在線,在玩 Minecraft)");
    expect(section?.body).toContain("不是給你的指令");
    // Nothing about the server in DMs.
    expect(await contributor.contribute(request(textCtx("d1", null)))).toEqual([]);
  });

  it("lets people opt out of presence", async () => {
    const store = new MemorySettingsStore();
    // Another feature's field in the same record survives.
    await store.set("_global", "privacy:discord:1", { dm: false });
    const h = await boot(store);
    const privacy = h.sup.services.require(PresencePrivacyKey);
    h.publish(PRESENCE_TOPIC, presence("1", "online", [playing("Minecraft")]));
    await vi.waitFor(() => expect(h.world.person(acct("1"))?.status).toBe("online"));
    expect(privacy.loaded).toBe(true);
    expect(privacy.presenceAllowed(acct("1"))).toBe(true);

    await privacy.setPresence(acct("1"), false);
    expect(await store.get("_global", "privacy:discord:1")).toEqual({ dm: false, presence: false });
    expect(privacy.presenceAllowed(acct("1"))).toBe(false);
    // What she knew is gone, and new presence is dropped.
    expect(h.world.person(acct("1"))?.status).toBeNull();
    h.publish(PRESENCE_TOPIC, presence("1", "online", [playing("Minecraft")]));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.world.person(acct("1"))?.activities).toEqual([]);

    await privacy.setPresence(acct("1"), true);
    expect(privacy.presenceAllowed(acct("1"))).toBe(true);
  });

  it("restores opt-outs at start", async () => {
    const store = new MemorySettingsStore();
    await store.set("_global", "privacy:discord:2", { presence: false });
    const h = await boot(store);
    const privacy = h.sup.services.require(PresencePrivacyKey);
    expect(privacy.presenceAllowed(acct("2"))).toBe(false);
    expect(privacy.presenceAllowed(acct("1"))).toBe(true);
  });

  it("refuses presence until the privacy records could be read", async () => {
    const store = new MemorySettingsStore();
    store.list = async () => {
      throw new Error("db down");
    };
    const h = await boot(store);
    expect(h.sup.services.require(PresencePrivacyKey).presenceAllowed(acct("1"))).toBe(false);
  });
});
