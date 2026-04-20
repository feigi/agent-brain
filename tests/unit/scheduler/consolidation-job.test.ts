import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ConsolidationJob,
  CONSOLIDATION_JOB_NAME,
} from "../../../src/scheduler/consolidation-job.js";
import type { ConsolidationService } from "../../../src/services/consolidation-service.js";
import type { Database } from "../../../src/db/index.js";
import type { SchedulerStateRepository } from "../../../src/repositories/types.js";

type ExecuteFn = (...args: unknown[]) => Promise<unknown>;

function makeDb(executeFn: ExecuteFn): Database {
  return { execute: executeFn } as unknown as Database;
}

function makeLockDb(opts: { acquire?: boolean; unlockThrows?: boolean }): {
  db: Database;
  calls: string[];
} {
  const { acquire = true, unlockThrows = false } = opts;
  const calls: string[] = [];
  // Execute is called twice per job run: first acquires the advisory lock,
  // second releases it. Mock by call order rather than by SQL inspection
  // (drizzle's `sql` returns a template object, not a string).
  const db = makeDb(async () => {
    if (calls.length === 0) {
      calls.push("lock");
      return [{ acquired: acquire }];
    }
    calls.push("unlock");
    if (unlockThrows) throw new Error("unlock failed");
    return [];
  });
  return { db, calls };
}

function makeService(run: () => Promise<unknown>): ConsolidationService {
  return { run } as unknown as ConsolidationService;
}

function makeRepo(
  recordRun: (jobName: string, runAt: Date) => Promise<void>,
): SchedulerStateRepository {
  return {
    getLastRun: vi.fn(async () => null),
    recordRun,
  };
}

describe("ConsolidationJob.execute", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("records run after successful service.run", async () => {
    const { db } = makeLockDb({ acquire: true });
    const service = makeService(async () => ({
      archived: 1,
      flagged: 0,
      errors: 0,
      flags: [],
    }));
    const recordRun = vi.fn<(jobName: string, runAt: Date) => Promise<void>>(
      async () => {},
    );
    const repo = makeRepo(recordRun);

    const job = new ConsolidationJob(service, db, repo);
    await job.execute();

    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(recordRun.mock.calls[0][0]).toBe(CONSOLIDATION_JOB_NAME);
    expect(recordRun.mock.calls[0][1]).toBeInstanceOf(Date);
    expect(job.isRunning).toBe(false);
  });

  it("does NOT record run when service.run throws", async () => {
    const { db } = makeLockDb({ acquire: true });
    const service = makeService(async () => {
      throw new Error("boom");
    });
    const recordRun = vi.fn(async () => {});
    const repo = makeRepo(recordRun);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const job = new ConsolidationJob(service, db, repo);
    await job.execute();

    expect(recordRun).not.toHaveBeenCalled();
    expect(job.isRunning).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does NOT record run and does NOT call service when lock not acquired", async () => {
    const { db } = makeLockDb({ acquire: false });
    const run = vi.fn(async () => ({
      archived: 0,
      flagged: 0,
      errors: 0,
      flags: [],
    }));
    const service = makeService(run);
    const recordRun = vi.fn(async () => {});
    const repo = makeRepo(recordRun);

    const job = new ConsolidationJob(service, db, repo);
    await job.execute();

    expect(run).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("logs distinct message when recordRun throws but does not mask job success", async () => {
    const { db } = makeLockDb({ acquire: true });
    const service = makeService(async () => ({
      archived: 2,
      flagged: 0,
      errors: 0,
      flags: [],
    }));
    const recordRun = vi.fn(async () => {
      throw new Error("record failed");
    });
    const repo = makeRepo(recordRun);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const job = new ConsolidationJob(service, db, repo);
    await job.execute();

    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(job.isRunning).toBe(false);
    // Distinct from "Consolidation job failed" — must mention recordRun.
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("recordRun");
    expect(logged).not.toContain("Consolidation job failed");
  });

  it("resets running=false even when pg_advisory_unlock throws", async () => {
    const { db } = makeLockDb({ acquire: true, unlockThrows: true });
    const service = makeService(async () => ({
      archived: 0,
      flagged: 0,
      errors: 0,
      flags: [],
    }));
    const repo = makeRepo(async () => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = new ConsolidationJob(service, db, repo);
    await job.execute();

    expect(job.isRunning).toBe(false);
  });
});
