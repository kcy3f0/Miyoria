import { customEvent, serviceKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EventBus, ServiceRegistry, ServiceUnavailableError, TopicFilter } from "../src/index.js";

describe("TopicFilter", () => {
  it("topic_filter", () => {
    const f = new TopicFilter(["platform.*", "agent.decision"]);
    expect(f.matches("platform.message.created")).toBe(true);
    expect(f.matches("agent.decision")).toBe(true);
    expect(f.matches("platformx.y")).toBe(false);
    expect(f.matches("platform")).toBe(false);
    expect(f.matches("agent.turn.started")).toBe(false);
    expect(TopicFilter.all().matches("anything")).toBe(true);
    expect(TopicFilter.from("voice.*").matches("voice.joined")).toBe(true);
  });
});

describe("EventBus", () => {
  it("subscription_filters", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(new TopicFilter(["custom.b"]));
    for (const topic of ["custom.a", "custom.b"]) bus.publish("test", customEvent(topic, null));
    const env = await sub.recv();
    expect(env?.event).toEqual(customEvent("custom.b", null));
  });

  it("delivers in order to every subscriber, also to a waiting one", async () => {
    const bus = new EventBus();
    const a = bus.subscribe("*");
    const b = bus.subscribe(["x.*"]);
    const waiting = b.recv();
    bus.publish("m", customEvent("x.1", 1));
    bus.publish("m", customEvent("y.1", 2), { correlation: "01JC0000000000000000000000" });
    bus.publish("m", customEvent("x.2", 3));
    expect((await waiting)?.event.data).toMatchObject({ topic: "x.1" });
    expect((await b.recv())?.event.data).toMatchObject({ topic: "x.2" });
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push((await a.recv())?.correlation);
    expect(seen).toEqual([null, "01JC0000000000000000000000", null]);
  });

  it("drops the oldest events of a lagging subscriber", async () => {
    const bus = new EventBus({ capacity: 2 });
    const sub = bus.subscribe("*");
    for (const n of [1, 2, 3]) bus.publish("m", customEvent("t", n));
    const first = await sub.recv();
    expect(first?.event).toEqual(customEvent("t", 2));
  });

  it("closing ends iteration; an aborted signal closes the subscription", async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const sub = bus.subscribe("*", { signal: controller.signal });
    const seen: unknown[] = [];
    const loop = (async () => {
      for await (const env of sub) seen.push(env.event.data);
    })();
    bus.publish("m", customEvent("t", 1));
    await Promise.resolve();
    controller.abort();
    await loop;
    expect(seen).toHaveLength(1);
    expect(await sub.recv()).toBeNull();
    expect(bus.subscriberCount).toBe(0);

    const late = bus.subscribe("*", { signal: controller.signal });
    expect(late.closed).toBe(true);
  });
});

describe("ServiceRegistry", () => {
  interface Greeter {
    greet(): string;
  }
  const GreeterKey = serviceKey<Greeter>("Greeter");

  it("provide_get_remove", () => {
    const reg = new ServiceRegistry();
    expect(reg.get(GreeterKey)).toBeUndefined();
    reg.provide("m", GreeterKey, { greet: () => "hi" });
    expect(reg.require(GreeterKey).greet()).toBe("hi");
    expect(reg.ownerOf(GreeterKey)).toBe("m");
    reg.removeOwnedBy("m");
    expect(reg.get(GreeterKey)).toBeUndefined();
    expect(() => reg.require(GreeterKey)).toThrow(ServiceUnavailableError);
    expect(() => reg.require(GreeterKey)).toThrow("service `Greeter` is not available");
  });
});
