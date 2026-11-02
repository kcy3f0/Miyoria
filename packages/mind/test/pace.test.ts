import { describe, expect, it } from "vitest";
import { CallLog, heartbeatMs, inQuietHours, mindConfig, type Pace } from "../src/index.js";

const MIN = 60_000;
const quiet: Pace = {
  lively: false,
  inVoice: false,
  agendaDue: false,
  night: false,
  budget: "ok",
  idleStreak: 0,
  boredom: 0.3,
};

describe("heartbeat", () => {
  const cfg = mindConfig();

  it("is sparse when nothing happens and denser when lively or an agenda item is due", () => {
    expect(heartbeatMs(quiet, cfg)).toBe(12 * MIN);
    expect(heartbeatMs({ ...quiet, lively: true }, cfg)).toBe(4 * MIN);
    expect(heartbeatMs({ ...quiet, inVoice: true }, cfg)).toBe(4 * MIN);
    expect(heartbeatMs({ ...quiet, agendaDue: true }, cfg)).toBe(3 * MIN);
    expect(heartbeatMs({ ...quiet, boredom: 0.8 }, cfg)).toBe(9 * MIN);
  });

  it("slows down after idle heartbeats, at night and on a degraded budget", () => {
    expect(heartbeatMs({ ...quiet, idleStreak: 1 }, cfg)).toBe(18 * MIN);
    expect(heartbeatMs({ ...quiet, idleStreak: 2 }, cfg)).toBe(27 * MIN);
    expect(heartbeatMs({ ...quiet, lively: true, night: true }, cfg)).toBe(12 * MIN);
    expect(heartbeatMs({ ...quiet, lively: true, budget: "degraded" }, cfg)).toBe(12 * MIN);
    // Capped by `max_heartbeat_mins`, none while exhausted.
    expect(heartbeatMs({ ...quiet, night: true, idleStreak: 9 }, cfg)).toBe(30 * MIN);
    expect(heartbeatMs({ ...quiet, budget: "exhausted" }, cfg)).toBeNull();
  });

  it("never comes faster than the minimum interval", () => {
    const fast = mindConfig({ min_interval_secs: 600 });
    expect(heartbeatMs({ ...quiet, agendaDue: true }, fast)).toBe(10 * MIN);
  });

  it("knows quiet hours in her time zone", () => {
    const cfg8 = mindConfig({ quiet_start_hour: 1, quiet_end_hour: 7, utc_offset_minutes: 480 });
    // 18:00 UTC = 02:00 at UTC+8.
    expect(inQuietHours(Date.parse("2026-11-02T18:00:00Z"), cfg8)).toBe(true);
    expect(inQuietHours(Date.parse("2026-11-02T23:30:00Z"), cfg8)).toBe(false);
    const wrap = mindConfig({ quiet_start_hour: 23, quiet_end_hour: 6, utc_offset_minutes: 0 });
    expect(inQuietHours(Date.parse("2026-11-02T23:30:00Z"), wrap)).toBe(true);
    expect(inQuietHours(Date.parse("2026-11-02T12:00:00Z"), wrap)).toBe(false);
    const none = mindConfig({ quiet_start_hour: 3, quiet_end_hour: 3 });
    expect(inQuietHours(Date.parse("2026-11-02T19:00:00Z"), none)).toBe(false);
  });
});

describe("call log", () => {
  it("enforces the minimum interval and the hourly cap", () => {
    const log = new CallLog(mindConfig({ max_calls_per_hour: 2, min_interval_secs: 60 }));
    const t0 = 1_000_000;
    expect(log.waitMs(t0)).toBe(0);
    log.record(t0);
    expect(log.waitMs(t0 + 10_000)).toBe(50_000);
    log.record(t0 + 60_000);
    expect(log.lastHour(t0 + 60_000)).toBe(2);
    // Capped: the oldest call has to leave the hour first.
    expect(log.waitMs(t0 + 120_000)).toBe(60 * MIN - 120_000);
    expect(log.waitMs(t0 + 60 * MIN)).toBe(0);
    expect(log.total).toBe(2);
    expect(new CallLog(mindConfig({ max_calls_per_hour: 0 })).waitMs(t0)).toBe(Infinity);
  });
});
