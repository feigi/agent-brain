import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getTestDb, truncateAll, closeDb } from "../helpers.js";
import { DrizzleSchedulerStateRepository } from "../../src/repositories/scheduler-state-repository.js";
import { ConsolidationScheduler } from "../../src/scheduler/consolidation-scheduler.js";
import {
  ConsolidationJob,
  CONSOLIDATION_JOB_NAME,
} from "../../src/scheduler/consolidation-job.js";
import type { SchedulerStateRepository } from "../../src/repositories/types.js";

describe("DrizzleSchedulerStateRepository", () => {
  let repo: DrizzleSchedulerStateRepository;

  beforeEach(async () => {
    await truncateAll();
    repo = new DrizzleSchedulerStateRepository(getTestDb());
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns null for unknown job", async () => {
    const result = await repo.getLastRun(CONSOLIDATION_JOB_NAME);
    expect(result).toBeNull();
  });

  it("records run and reads it back", async () => {
    const when = new Date("2026-04-20T10:00:00Z");
    await repo.recordRun(CONSOLIDATION_JOB_NAME, when);
    const result = await repo.getLastRun(CONSOLIDATION_JOB_NAME);
    expect(result?.toISOString()).toBe(when.toISOString());
  });

  it("advances last_run_at on monotonic repeat call", async () => {
    const t1 = new Date("2026-04-20T10:00:00Z");
    const t2 = new Date("2026-04-21T10:00:00Z");
    await repo.recordRun(CONSOLIDATION_JOB_NAME, t1);
    await repo.recordRun(CONSOLIDATION_JOB_NAME, t2);
    const result = await repo.getLastRun(CONSOLIDATION_JOB_NAME);
    expect(result?.toISOString()).toBe(t2.toISOString());
  });

  it("does NOT regress last_run_at on out-of-order write (monotonic guard)", async () => {
    const newer = new Date("2026-04-21T10:00:00Z");
    const older = new Date("2026-04-20T10:00:00Z");
    await repo.recordRun(CONSOLIDATION_JOB_NAME, newer);
    await repo.recordRun(CONSOLIDATION_JOB_NAME, older);
    const result = await repo.getLastRun(CONSOLIDATION_JOB_NAME);
    expect(result?.toISOString()).toBe(newer.toISOString());
  });
});

describe("ConsolidationScheduler catch-up", () => {
  let repo: DrizzleSchedulerStateRepository;

  beforeEach(async () => {
    await truncateAll();
    repo = new DrizzleSchedulerStateRepository(getTestDb());
  });

  afterAll(async () => {
    await closeDb();
  });

  function fakeJobFactory() {
    let executed = 0;
    const job = {
      isRunning: false,
      execute: async () => {
        executed++;
      },
    } as unknown as ConsolidationJob;
    return { job, count: () => executed };
  }

  it("invokes the job on start when last_run is stale", async () => {
    await repo.recordRun(
      CONSOLIDATION_JOB_NAME,
      new Date("2020-01-01T00:00:00Z"),
    );
    const { job, count } = fakeJobFactory();

    const scheduler = new ConsolidationScheduler(job, "0 3 * * *", repo, {
      enabled: true,
      graceSeconds: 60,
    });
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    await scheduler.stop();

    expect(count()).toBe(1);
  });

  it("does NOT invoke the job when last_run is recent", async () => {
    await repo.recordRun(CONSOLIDATION_JOB_NAME, new Date());
    const { job, count } = fakeJobFactory();

    const scheduler = new ConsolidationScheduler(job, "0 3 * * *", repo, {
      enabled: true,
      graceSeconds: 60,
    });
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    await scheduler.stop();

    expect(count()).toBe(0);
  });

  it("does NOT invoke catch-up when enabled=false, even with stale last_run", async () => {
    await repo.recordRun(
      CONSOLIDATION_JOB_NAME,
      new Date("2020-01-01T00:00:00Z"),
    );
    const { job, count } = fakeJobFactory();

    const scheduler = new ConsolidationScheduler(job, "0 3 * * *", repo, {
      enabled: false,
      graceSeconds: 60,
    });
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    await scheduler.stop();

    expect(count()).toBe(0);
  });

  it("round-trip: catch-up runs once, records last_run_at, second start does not catch up", async () => {
    // First boot: stale state triggers catch-up; fake job calls recordRun itself.
    const job1 = {
      isRunning: false,
      execute: async () => {
        await repo.recordRun(CONSOLIDATION_JOB_NAME, new Date());
      },
    } as unknown as ConsolidationJob;

    const scheduler1 = new ConsolidationScheduler(job1, "0 3 * * *", repo, {
      enabled: true,
      graceSeconds: 60,
    });
    await scheduler1.start();
    await new Promise((r) => setTimeout(r, 50));
    await scheduler1.stop();

    // Second boot: should NOT catch up because last_run_at is fresh.
    const { job: job2, count } = fakeJobFactory();
    const scheduler2 = new ConsolidationScheduler(job2, "0 3 * * *", repo, {
      enabled: true,
      graceSeconds: 60,
    });
    await scheduler2.start();
    await new Promise((r) => setTimeout(r, 50));
    await scheduler2.stop();

    expect(count()).toBe(0);
  });

  it("schedules cron tick even when getLastRun throws at startup", async () => {
    const throwingRepo: SchedulerStateRepository = {
      getLastRun: async () => {
        throw new Error("DB unavailable");
      },
      recordRun: async () => {},
    };
    const { job, count } = fakeJobFactory();

    const scheduler = new ConsolidationScheduler(
      job,
      "0 3 * * *",
      throwingRepo,
      { enabled: true, graceSeconds: 60 },
    );

    // start() must resolve despite repo error — scheduled cron still registers.
    await expect(scheduler.start()).resolves.toBeUndefined();
    await scheduler.stop();

    // Catch-up skipped because getLastRun threw.
    expect(count()).toBe(0);
  });

  it("constructor throws on invalid cron expression", () => {
    const { job } = fakeJobFactory();
    expect(
      () =>
        new ConsolidationScheduler(job, "not-a-cron", repo, {
          enabled: false,
          graceSeconds: 60,
        }),
    ).toThrow(/Invalid cron expression/);
  });
});
