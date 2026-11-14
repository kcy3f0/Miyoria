import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "../src/bridge.js";
import type { Snapshot } from "../src/summary.js";
import { ScreenshotPolicy } from "../src/vision.js";

const baseSnap = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  dimension: "overworld",
  biome: "plains",
  position: { x: 0, y: 64, z: 0 },
  nearby_entities: [],
  nearby_blocks: [],
  ...overrides,
});

describe("ScreenshotPolicy", () => {
  it("captures only on demand and respects vision_enabled and capabilitySupported", async () => {
    const disabled = new ScreenshotPolicy({ enabled: false });
    disabled.forceNext("inspect");
    expect(disabled.evaluate(baseSnap(), true)).toEqual({ capture: false });

    const unsupported = new ScreenshotPolicy({ enabled: true });
    unsupported.forceNext("inspect");
    expect(unsupported.evaluate(baseSnap(), false)).toEqual({ capture: false });

    // Routine quiet snapshot does not capture automatically.
    const policy = new ScreenshotPolicy();
    expect(policy.evaluate(baseSnap(), true)).toEqual({ capture: false });
  });

  it("bypasses cooldown on inspect (forceNext) and captures compressed JPEG with high detail", async () => {
    let clock = 10_000;
    const calls: Array<{ type: string; params: Record<string, unknown> }> = [];
    const policy = new ScreenshotPolicy({
      now: () => clock,
      cooldownMs: 15_000,
      maxWidth: 512,
      quality: 0.65,
    });

    const req = async (type: string, params: Record<string, unknown> = {}) => {
      calls.push({ type, params });
      return { mime: "image/jpeg", data_base64: "AQID" };
    };

    // Baseline established quietly.
    expect(await policy.maybeCapture(baseSnap(), req, true)).toBeUndefined();
    expect(calls).toHaveLength(0);

    // Explicit inspect triggers capture immediately.
    policy.forceNext("看看前面房子");
    const first = await policy.maybeCapture(baseSnap(), req, true);
    expect(first).toEqual({ mime: "image/jpeg", data: "AQID", detail: "high", alt: "看看前面房子" });
    expect(calls[0]).toEqual({ type: "screenshot", params: { max_width: 512, format: "jpeg", quality: 0.65 } });

    // Automatic failure trigger is blocked during 15s cooldown...
    clock += 2_000;
    policy.noteFailure("unreachable:找不到路");
    expect(await policy.maybeCapture(baseSnap(), req, true)).toBeUndefined();

    // ...except explicit inspect still bypasses cooldown!
    policy.forceNext("再看一次");
    const second = await policy.maybeCapture(baseSnap(), req, true);
    expect(second?.detail).toBe("high");
    expect(calls).toHaveLength(2);
  });

  it("triggers after cooldown on failure/stuck reflex, biome/dimension changes, >=48 blocks move, or new players/structures", async () => {
    let clock = 50_000;
    const policy = new ScreenshotPolicy({ now: () => clock, cooldownMs: 15_000, moveDistance: 48 });
    const req = async () => ({ mime: "image/jpeg", data_base64: "AA==" });

    // Establish initial baseline at (0, 64, 0) plains / overworld.
    expect(await policy.maybeCapture(baseSnap(), req, true)).toBeUndefined();

    // 1. Stuck reflex event triggers after cooldown (first capture has no prior cooldown).
    policy.noteEvent({ name: "reflex", data: { kind: "unstuck" } } satisfies BridgeEvent);
    const stuckShot = await policy.maybeCapture(baseSnap(), req, true);
    expect(stuckShot?.detail).toBe("low");
    expect(stuckShot?.alt).toContain("reflex:unstuck");

    // 2. Small move inside cooldown & after cooldown (< 48 blocks) stays quiet.
    clock += 16_000;
    expect(await policy.maybeCapture(baseSnap({ position: { x: 20, y: 64, z: 0 } }), req, true)).toBeUndefined();

    // 3. Moving >= 48 blocks from last capture anchor triggers capture.
    const movedShot = await policy.maybeCapture(baseSnap({ position: { x: 48, y: 64, z: 0 } }), req, true);
    expect(movedShot?.alt).toContain("移動超過 48 格");

    // 4. Biome change triggers after cooldown.
    clock += 16_000;
    const biomeShot = await policy.maybeCapture(
      baseSnap({ position: { x: 48, y: 64, z: 0 }, biome: "birch_forest" }),
      req,
      true,
    );
    expect(biomeShot?.alt).toContain("birch_forest");

    // 5. Dimension change triggers after cooldown.
    clock += 16_000;
    const dimShot = await policy.maybeCapture(
      baseSnap({ position: { x: 6, y: 64, z: 0 }, biome: "birch_forest", dimension: "the_nether" }),
      req,
      true,
    );
    expect(dimShot?.alt).toContain("the_nether");

    // 6. Nearby other player triggers after cooldown.
    clock += 16_000;
    const playerShot = await policy.maybeCapture(
      baseSnap({
        position: { x: 6, y: 64, z: 0 },
        biome: "birch_forest",
        dimension: "the_nether",
        nearby_entities: [{ type: "player", name: "Alex", distance: 10, hostile: false }],
      }),
      req,
      true,
    );
    expect(playerShot?.alt).toContain("Alex");

    // 7. New structure block triggers after cooldown.
    clock += 16_000;
    const structShot = await policy.maybeCapture(
      baseSnap({
        position: { x: 6, y: 64, z: 0 },
        biome: "birch_forest",
        dimension: "the_nether",
        nearby_entities: [{ type: "player", name: "Alex", distance: 10, hostile: false }],
        nearby_blocks: [{ block: "spawner", count: 1, distance: 6, nearest: { x: 8, y: 64, z: 2 } }],
      }),
      req,
      true,
    );
    expect(structShot?.alt).toContain("spawner");
  });

  it("falls back cleanly to undefined when screenshot request fails or returns empty payload", async () => {
    const policy = new ScreenshotPolicy();
    policy.forceNext("test failure");
    expect(
      await policy.maybeCapture(
        baseSnap(),
        async () => {
          throw new Error("render thread busy");
        },
        true,
      ),
    ).toBeUndefined();

    policy.forceNext("empty response");
    expect(await policy.maybeCapture(baseSnap(), async () => ({}), true)).toBeUndefined();
  });
});
