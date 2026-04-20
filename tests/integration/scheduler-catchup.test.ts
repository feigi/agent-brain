import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getTestDb, truncateAll, closeDb } from "../helpers.js";
import { schedulerState } from "../../src/db/schema.js";
import { DrizzleSchedulerStateRepository } from "../../src/repositories/scheduler-state-repository.js";
import { ConsolidationScheduler } from "../../src/scheduler/consolidation-scheduler.js";
import {
  ConsolidationJob,
  CONSOLIDATION_JOB_NAME,
} from "../../src/scheduler/consolidation-job.js";

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

describe("ConsolidationScheduler catch-up", () => {
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

  it("invokes the job on start when last_run is stale", async () => {
    await repo.recordRun(
      CONSOLIDATION_JOB_NAME,
      new Date("2020-01-01T00:00:00Z"),
    );

    let executed = 0;
    const fakeJob = {
      isRunning: false,
      execute: async () => {
        executed++;
      },
    } as unknown as ConsolidationJob;

    const scheduler = new ConsolidationScheduler(fakeJob, "0 3 * * *", repo, {
      enabled: true,
      graceSeconds: 60,
    });
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    await scheduler.stop();

    expect(executed).toBe(1);
  });

  it("does NOT invoke the job when last_run is recent", async () => {
    await repo.recordRun(CONSOLIDATION_JOB_NAME, new Date());

    let executed = 0;
    const fakeJob = {
      isRunning: false,
      execute: async () => {
        executed++;
      },
    } as unknown as ConsolidationJob;

    const scheduler = new ConsolidationScheduler(fakeJob, "0 3 * * *", repo, {
      enabled: true,
      graceSeconds: 60,
    });
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    await scheduler.stop();

    expect(executed).toBe(0);
  });
});
