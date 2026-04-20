import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getTestDb, truncateAll, closeDb } from "../helpers.js";
import { schedulerState } from "../../src/db/schema.js";
import { DrizzleSchedulerStateRepository } from "../../src/repositories/scheduler-state-repository.js";

describe("DrizzleSchedulerStateRepository", () => {
  let repo: DrizzleSchedulerStateRepository;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    await db.delete(schedulerState);
    repo = new DrizzleSchedulerStateRepository(db);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns null for unknown job", async () => {
    const result = await repo.getLastRun("nonexistent");
    expect(result).toBeNull();
  });

  it("records run and reads it back", async () => {
    const when = new Date("2026-04-20T10:00:00Z");
    await repo.recordRun("consolidation", when);
    const result = await repo.getLastRun("consolidation");
    expect(result?.toISOString()).toBe(when.toISOString());
  });

  it("overwrites existing run on repeat call", async () => {
    const t1 = new Date("2026-04-20T10:00:00Z");
    const t2 = new Date("2026-04-21T10:00:00Z");
    await repo.recordRun("consolidation", t1);
    await repo.recordRun("consolidation", t2);
    const result = await repo.getLastRun("consolidation");
    expect(result?.toISOString()).toBe(t2.toISOString());
  });
});
