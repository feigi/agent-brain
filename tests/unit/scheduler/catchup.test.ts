import { describe, it, expect } from "vitest";
import { shouldCatchUp } from "../../../src/scheduler/consolidation-scheduler.js";

describe("shouldCatchUp", () => {
  const cronExpr = "0 3 * * *"; // 03:00 daily

  it("returns true when last run is before previous tick", () => {
    const now = new Date("2026-04-20T10:00:00Z");
    const lastRun = new Date("2026-04-18T03:00:00Z");
    expect(shouldCatchUp(cronExpr, lastRun, now, 60)).toBe(true);
  });

  it("returns false when last run is after previous tick", () => {
    const now = new Date("2026-04-20T10:00:00Z");
    const lastRun = new Date("2026-04-20T03:00:05Z");
    expect(shouldCatchUp(cronExpr, lastRun, now, 60)).toBe(false);
  });

  it("returns true when last run is null (first-ever startup)", () => {
    const now = new Date("2026-04-20T10:00:00Z");
    expect(shouldCatchUp(cronExpr, null, now, 60)).toBe(true);
  });

  it("returns false when last run is within grace window before prev tick", () => {
    // prev tick = 2026-04-20T03:00:00Z; grace 60s -> skip if lastRun >= 02:59:00Z
    const now = new Date("2026-04-20T10:00:00Z");
    const lastRun = new Date("2026-04-20T02:59:30Z");
    expect(shouldCatchUp(cronExpr, lastRun, now, 60)).toBe(false);
  });

  it("returns false for invalid cron expression", () => {
    const now = new Date("2026-04-20T10:00:00Z");
    expect(shouldCatchUp("not-a-cron", null, now, 60)).toBe(false);
  });
});
