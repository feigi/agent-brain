import { describe, it, expect } from "vitest";
import {
  getPrevTick,
  shouldCatchUp,
} from "../../../src/scheduler/consolidation-scheduler.js";

describe("getPrevTick", () => {
  it("returns the most recent scheduled tick before now (tz-neutral cron)", () => {
    // Every minute — tz-independent so test is stable regardless of runner TZ.
    const now = new Date("2026-04-20T10:00:30Z");
    const prev = getPrevTick("* * * * *", now);
    expect(prev.toISOString()).toBe("2026-04-20T10:00:00.000Z");
  });

  it("returns a Date strictly before now", () => {
    const now = new Date("2026-04-20T10:00:30Z");
    const prev = getPrevTick("0 3 * * *", now);
    expect(prev.getTime()).toBeLessThan(now.getTime());
  });

  it("throws on unparseable cron expression", () => {
    expect(() => getPrevTick("not-a-cron", new Date())).toThrow();
  });
});

describe("shouldCatchUp", () => {
  const prevTick = new Date("2026-04-20T03:00:00Z");

  it("returns true when last run is before previous tick", () => {
    const lastRun = new Date("2026-04-18T03:00:00Z");
    expect(shouldCatchUp(prevTick, lastRun, 60)).toBe(true);
  });

  it("returns false when last run is after previous tick", () => {
    const lastRun = new Date("2026-04-20T03:00:05Z");
    expect(shouldCatchUp(prevTick, lastRun, 60)).toBe(false);
  });

  it("returns true when last run is null (first-ever startup)", () => {
    expect(shouldCatchUp(prevTick, null, 60)).toBe(true);
  });

  it("returns false when last run is within grace window before prev tick", () => {
    // grace 60s -> skip if lastRun >= 02:59:00Z
    const lastRun = new Date("2026-04-20T02:59:30Z");
    expect(shouldCatchUp(prevTick, lastRun, 60)).toBe(false);
  });

  it("returns false at exact grace boundary (lastRun + grace === prevTick)", () => {
    const lastRun = new Date("2026-04-20T02:59:00Z"); // + 60s === prevTick
    expect(shouldCatchUp(prevTick, lastRun, 60)).toBe(false);
  });

  it("returns true just outside grace boundary (lastRun + grace = prevTick - 1ms)", () => {
    const lastRun = new Date(prevTick.getTime() - 60_000 - 1);
    expect(shouldCatchUp(prevTick, lastRun, 60)).toBe(true);
  });

  it("with graceSeconds=0 returns false when lastRun equals prevTick", () => {
    expect(shouldCatchUp(prevTick, prevTick, 0)).toBe(false);
  });

  it("with graceSeconds=0 returns true when lastRun is 1ms before prevTick", () => {
    const lastRun = new Date(prevTick.getTime() - 1);
    expect(shouldCatchUp(prevTick, lastRun, 0)).toBe(true);
  });
});
