# Scheduler Startup Catch-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the MCP server starts, run the consolidation job immediately if the last scheduled tick was missed (e.g. server was down during the cron time).

**Architecture:** Persist `last_run` per scheduler job in a new small `scheduler_state` DB table. On `ConsolidationScheduler.start()`, compute the most recent cron tick using `cron-parser`, compare with the stored `last_run`, and fire a catch-up execution if the stored value is older than that tick. Update `last_run` inside `ConsolidationJob.execute()` after a successful run (under the same advisory lock that already guards concurrency). Add a configurable grace threshold so a restart just after a successful run does not re-trigger, and so a very long outage does not spam: at most **one** catch-up per startup.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, node-cron v4, `cron-parser` (new dep), Vitest.

---

## File Structure

- **Create**
  - `drizzle/0011_scheduler_state.sql` — migration adding `scheduler_state` table.
  - `src/repositories/scheduler-state-repository.ts` — Drizzle implementation of the repo interface.
  - `tests/unit/scheduler/catchup.test.ts` — unit tests for catch-up decision logic.
  - `tests/integration/scheduler-catchup.test.ts` — integration test against real Postgres + real job.

- **Modify**
  - `src/db/schema.ts` — add `schedulerState` table definition.
  - `src/repositories/types.ts` — add `SchedulerStateRepository` interface.
  - `src/scheduler/consolidation-job.ts` — accept repo, update `last_run` after successful run, expose `jobName` constant.
  - `src/scheduler/consolidation-scheduler.ts` — run catch-up check in `start()`.
  - `src/server.ts` — wire new repo into `ConsolidationJob`.
  - `src/config.ts` — add `CONSOLIDATION_CATCHUP_ENABLED` (default true) and `CONSOLIDATION_CATCHUP_GRACE_SECONDS` (default 60).
  - `package.json` — add `cron-parser` dep.

---

## Task 1: Add `cron-parser` dependency

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install**

```bash
npm install cron-parser@^4.9.0
```

- [ ] **Step 2: Verify typecheck still clean**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add cron-parser for prev-tick calculation"
```

---

## Task 2: Add `scheduler_state` table — schema + migration

**Files:**

- Modify: `src/db/schema.ts`
- Create: `drizzle/0011_scheduler_state.sql`

- [ ] **Step 1: Add table to schema**

Append to `src/db/schema.ts` (after the `workspaces` table block, before `memories`):

```ts
export const schedulerState = pgTable("scheduler_state", {
  job_name: text("job_name").primaryKey(),
  last_run_at: timestamp("last_run_at", { withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

- [ ] **Step 2: Generate migration**

Run: `npm run db:generate`
Expected: a new file `drizzle/0011_*.sql` is created.

- [ ] **Step 3: Rename generated migration to stable name**

```bash
mv drizzle/0011_*.sql drizzle/0011_scheduler_state.sql
```

Update `drizzle/meta/_journal.json` tag field of the new entry to `"0011_scheduler_state"` if the generator set something else.

- [ ] **Step 4: Verify migration content**

Read `drizzle/0011_scheduler_state.sql`. Expected content (approximate):

```sql
CREATE TABLE "scheduler_state" (
	"job_name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

- [ ] **Step 5: Apply migration locally**

Run: `docker compose up -d --wait && npm run db:migrate`
Expected: migration applied, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/0011_scheduler_state.sql drizzle/meta/_journal.json drizzle/meta/0011_snapshot.json
git commit -m "feat(db): add scheduler_state table for per-job last_run tracking"
```

---

## Task 3: Add `SchedulerStateRepository` interface

**Files:**

- Modify: `src/repositories/types.ts`

- [ ] **Step 1: Append interface**

Add at the bottom of `src/repositories/types.ts`:

```ts
export interface SchedulerStateRepository {
  getLastRun(jobName: string): Promise<Date | null>;
  recordRun(jobName: string, runAt: Date): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/types.ts
git commit -m "feat(repo): add SchedulerStateRepository interface"
```

---

## Task 4: Implement `DrizzleSchedulerStateRepository`

**Files:**

- Create: `src/repositories/scheduler-state-repository.ts`
- Test: `tests/integration/scheduler-catchup.test.ts` (partial — add repo-level coverage here)

- [ ] **Step 1: Write failing integration test for repo**

Create `tests/integration/scheduler-catchup.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, resetDb } from "../helpers.js";
import type { Database } from "../../src/db/index.js";
import { DrizzleSchedulerStateRepository } from "../../src/repositories/scheduler-state-repository.js";

describe("DrizzleSchedulerStateRepository", () => {
  let db: Database;
  let repo: DrizzleSchedulerStateRepository;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    repo = new DrizzleSchedulerStateRepository(db);
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
```

Note: use whatever helpers `tests/helpers.ts` actually exports. If names differ (`setupTestDb`/`resetDb`/`teardownTestDb`), adapt to the real helper names found at the top of existing files in `tests/integration/`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/scheduler-catchup.test.ts`
Expected: FAIL — module `scheduler-state-repository` not found.

- [ ] **Step 3: Implement repository**

Create `src/repositories/scheduler-state-repository.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { schedulerState } from "../db/schema.js";
import type { SchedulerStateRepository } from "./types.js";

export class DrizzleSchedulerStateRepository implements SchedulerStateRepository {
  constructor(private readonly db: Database) {}

  async getLastRun(jobName: string): Promise<Date | null> {
    const rows = await this.db
      .select({ last_run_at: schedulerState.last_run_at })
      .from(schedulerState)
      .where(eq(schedulerState.job_name, jobName))
      .limit(1);

    return rows.length > 0 ? rows[0].last_run_at : null;
  }

  async recordRun(jobName: string, runAt: Date): Promise<void> {
    await this.db
      .insert(schedulerState)
      .values({ job_name: jobName, last_run_at: runAt })
      .onConflictDoUpdate({
        target: schedulerState.job_name,
        set: { last_run_at: runAt, updated_at: sql`now()` },
      });
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run tests/integration/scheduler-catchup.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/scheduler-state-repository.ts tests/integration/scheduler-catchup.test.ts
git commit -m "feat(repo): implement DrizzleSchedulerStateRepository"
```

---

## Task 5: Persist `last_run` inside `ConsolidationJob`

**Files:**

- Modify: `src/scheduler/consolidation-job.ts`

- [ ] **Step 1: Add job-name constant and accept repo**

Replace the top of `src/scheduler/consolidation-job.ts` (constructor + fields) with:

```ts
import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { ConsolidationService } from "../services/consolidation-service.js";
import type { SchedulerStateRepository } from "../repositories/types.js";
import { logger } from "../utils/logger.js";

/** PostgreSQL advisory lock ID for consolidation job exclusivity across server instances */
const CONSOLIDATION_LOCK_ID = 42001;

export const CONSOLIDATION_JOB_NAME = "consolidation";

export class ConsolidationJob {
  private running = false;

  constructor(
    private readonly consolidationService: ConsolidationService,
    private readonly db: Database,
    private readonly schedulerStateRepo: SchedulerStateRepository,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }
```

- [ ] **Step 2: Record run after success**

In the `try` block of `execute()`, after the `logger.info(...)` that reports completion, append:

```ts
await this.schedulerStateRepo.recordRun(
  CONSOLIDATION_JOB_NAME,
  new Date(start),
);
```

Record `start` (not `Date.now()`) so the timestamp corresponds to the scheduled tick, not to post-completion. This matters because a long-running job that completes well after the next scheduled tick should still register as having covered the earlier tick.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: fails at `src/server.ts` because wiring missing — that's expected and fixed in Task 7. Skip to next step.

- [ ] **Step 4: Commit (deferred to Task 7 so build stays green per commit)**

Do not commit yet. Move on to Task 6.

---

## Task 6: Add catch-up logic in `ConsolidationScheduler`

**Files:**

- Modify: `src/scheduler/consolidation-scheduler.ts`
- Test: `tests/unit/scheduler/catchup.test.ts`

- [ ] **Step 1: Create test dir**

```bash
mkdir -p tests/unit/scheduler
```

- [ ] **Step 2: Write failing unit test for catch-up decision**

Extract the decision into a pure helper to keep it unit-testable. Create `tests/unit/scheduler/catchup.test.ts`:

```ts
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
    // prev tick = 2026-04-20T03:00:00Z; grace 60s → skip if lastRun >= 02:59:00Z
    const now = new Date("2026-04-20T10:00:00Z");
    const lastRun = new Date("2026-04-20T02:59:30Z");
    expect(shouldCatchUp(cronExpr, lastRun, now, 60)).toBe(false);
  });

  it("returns false for invalid cron expression", () => {
    const now = new Date("2026-04-20T10:00:00Z");
    expect(shouldCatchUp("not-a-cron", null, now, 60)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/scheduler/catchup.test.ts`
Expected: FAIL — `shouldCatchUp` not exported.

- [ ] **Step 4: Rewrite `consolidation-scheduler.ts`**

Replace the full contents of `src/scheduler/consolidation-scheduler.ts` with:

```ts
import cron from "node-cron";
import cronParser from "cron-parser";
import type { ConsolidationJob } from "./consolidation-job.js";
import { CONSOLIDATION_JOB_NAME } from "./consolidation-job.js";
import type { SchedulerStateRepository } from "../repositories/types.js";
import { logger } from "../utils/logger.js";

export interface CatchUpOptions {
  enabled: boolean;
  graceSeconds: number;
}

/**
 * Decide whether a catch-up run is needed.
 *
 * Why graceSeconds: protects against re-firing when the server restarts
 * seconds after a successful run — clock skew / transactional commit ordering
 * can make `lastRun` appear a hair before `prevTick`.
 */
export function shouldCatchUp(
  cronExpression: string,
  lastRun: Date | null,
  now: Date,
  graceSeconds: number,
): boolean {
  let prevTick: Date;
  try {
    const interval = cronParser.parseExpression(cronExpression, {
      currentDate: now,
    });
    prevTick = interval.prev().toDate();
  } catch {
    return false;
  }

  if (lastRun === null) return true;

  const graceMs = graceSeconds * 1000;
  return lastRun.getTime() + graceMs < prevTick.getTime();
}

export class ConsolidationScheduler {
  private task: cron.ScheduledTask | null = null;

  constructor(
    private readonly job: ConsolidationJob,
    private readonly cronExpression: string,
    private readonly schedulerStateRepo: SchedulerStateRepository,
    private readonly catchUp: CatchUpOptions,
  ) {}

  async start(): Promise<void> {
    if (!cron.validate(this.cronExpression)) {
      logger.error(
        `Invalid cron expression: ${this.cronExpression}, scheduler not started`,
      );
      return;
    }

    if (this.catchUp.enabled) {
      await this.runCatchUpIfNeeded();
    }

    this.task = cron.schedule(this.cronExpression, () => {
      this.job.execute().catch((error) => {
        logger.error("Consolidation job invocation failed:", error);
      });
    });

    logger.info(
      `Consolidation scheduler started with cron: ${this.cronExpression}`,
    );
  }

  private async runCatchUpIfNeeded(): Promise<void> {
    try {
      const lastRun = await this.schedulerStateRepo.getLastRun(
        CONSOLIDATION_JOB_NAME,
      );
      const now = new Date();
      if (
        shouldCatchUp(
          this.cronExpression,
          lastRun,
          now,
          this.catchUp.graceSeconds,
        )
      ) {
        logger.info(
          `Consolidation catch-up triggered on startup (last_run=${
            lastRun?.toISOString() ?? "never"
          })`,
        );
        // Fire-and-forget: do not block server startup on job completion.
        this.job.execute().catch((error) => {
          logger.error("Consolidation catch-up failed:", error);
        });
      }
    } catch (error) {
      logger.error("Consolidation catch-up check failed:", error);
    }
  }

  async stop(): Promise<void> {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }

    if (this.job.isRunning) {
      logger.info("Waiting for running consolidation job to finish...");
      const maxWait = 60_000;
      const start = Date.now();
      while (this.job.isRunning && Date.now() - start < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (this.job.isRunning) {
        logger.warn("Consolidation job did not finish within timeout");
      }
    }

    logger.info("Consolidation scheduler stopped");
  }
}
```

- [ ] **Step 5: Run unit test, verify pass**

Run: `npx vitest run tests/unit/scheduler/catchup.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Do not commit yet — wiring still missing**

Proceed to Task 7.

---

## Task 7: Wire new repo and config, update `server.ts` + `config.ts`

**Files:**

- Modify: `src/config.ts`, `src/server.ts`

- [ ] **Step 1: Extend config schema**

In `src/config.ts`, in the zod schema object, after `consolidationMaxFlagsPerSession`, add:

```ts
  consolidationCatchupEnabled: z
    .string()
    .optional()
    .transform((v) => v !== "false")
    .default("true"),
  consolidationCatchupGraceSeconds: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(60),
```

And in the env-mapping object (the block under `process.env.CONSOLIDATION_MAX_FLAGS_PER_SESSION`), add:

```ts
  consolidationCatchupEnabled: process.env.CONSOLIDATION_CATCHUP_ENABLED,
  consolidationCatchupGraceSeconds: process.env.CONSOLIDATION_CATCHUP_GRACE_SECONDS,
```

- [ ] **Step 2: Wire in `server.ts`**

In `src/server.ts`, near where other repositories are instantiated (search for `DrizzleWorkspaceRepository` and follow the local pattern), add:

```ts
import { DrizzleSchedulerStateRepository } from "./repositories/scheduler-state-repository.js";
```

```ts
const schedulerStateRepo = new DrizzleSchedulerStateRepository(db);
```

Then replace the existing block starting at line ~130:

```ts
if (config.consolidationEnabled) {
  const consolidationJob = new ConsolidationJob(consolidationService, db);
  consolidationScheduler = new ConsolidationScheduler(
    consolidationJob,
    config.consolidationCron,
  );
  consolidationScheduler.start();
}
```

with:

```ts
if (config.consolidationEnabled) {
  const consolidationJob = new ConsolidationJob(
    consolidationService,
    db,
    schedulerStateRepo,
  );
  consolidationScheduler = new ConsolidationScheduler(
    consolidationJob,
    config.consolidationCron,
    schedulerStateRepo,
    {
      enabled: config.consolidationCatchupEnabled,
      graceSeconds: config.consolidationCatchupGraceSeconds,
    },
  );
  await consolidationScheduler.start();
}
```

Note the `await` — `start()` is now async because it awaits the catch-up decision (the catch-up job itself is fire-and-forget).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Run full unit suite**

Run: `npm run test:unit`
Expected: all pass.

- [ ] **Step 5: Commit Tasks 5 + 6 + 7 together**

```bash
git add src/scheduler/consolidation-job.ts src/scheduler/consolidation-scheduler.ts src/config.ts src/server.ts tests/unit/scheduler/catchup.test.ts
git commit -m "feat(scheduler): catch-up run on startup when last tick missed"
```

---

## Task 8: Integration test — end-to-end catch-up fires on startup

**Files:**

- Modify: `tests/integration/scheduler-catchup.test.ts`

- [ ] **Step 1: Append integration test for scheduler**

Append to `tests/integration/scheduler-catchup.test.ts`:

```ts
import { ConsolidationScheduler } from "../../src/scheduler/consolidation-scheduler.js";
import {
  ConsolidationJob,
  CONSOLIDATION_JOB_NAME,
} from "../../src/scheduler/consolidation-job.js";

describe("ConsolidationScheduler catch-up", () => {
  let db: Database;
  let repo: DrizzleSchedulerStateRepository;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    repo = new DrizzleSchedulerStateRepository(db);
  });

  it("invokes the job on start when last_run is stale", async () => {
    // Seed a stale last_run far in the past.
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
    // Fire-and-forget — give the microtask queue a chance.
    await new Promise((r) => setTimeout(r, 50));
    await scheduler.stop();

    expect(executed).toBe(1);
  });

  it("does NOT invoke the job when last_run is recent", async () => {
    // Record a last_run after the most recent tick (03:00 today).
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
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run tests/integration/scheduler-catchup.test.ts`
Expected: all tests pass (3 repo tests from Task 4 + 2 scheduler tests = 5 total).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/scheduler-catchup.test.ts
git commit -m "test(scheduler): integration test for startup catch-up"
```

---

## Task 9: Manual smoke + docs

**Files:**

- Modify: `README.md` (only if it documents consolidation env vars — otherwise skip)

- [ ] **Step 1: Smoke test locally**

1. Ensure consolidation enabled: `export CONSOLIDATION_ENABLED=true`.
2. Start server: `npm run dev`.
3. Observe log: either `Consolidation catch-up triggered on startup` (first boot, no last_run) or `Consolidation scheduler started with cron: ...` only (after a recent run).
4. Stop server, wait past one scheduled tick (or temporarily set `CONSOLIDATION_CRON="* * * * *"`), restart. Expect catch-up log on the second boot.
5. Restore default cron.

- [ ] **Step 2: Update README if consolidation env vars are documented**

Run: `grep -n CONSOLIDATION_ README.md` — if results exist, add `CONSOLIDATION_CATCHUP_ENABLED` and `CONSOLIDATION_CATCHUP_GRACE_SECONDS` next to the existing entries with one-line descriptions. If README doesn't document these env vars, skip.

- [ ] **Step 3: Commit if README changed**

```bash
git add README.md
git commit -m "docs: document consolidation catch-up env vars"
```

---

## Self-Review Checklist

- Spec coverage: catch-up fires on startup ✓ (Task 6), persists `last_run` ✓ (Task 5), grace window ✓ (Task 6), opt-out env flag ✓ (Task 7), tests unit + integration ✓ (Tasks 6 + 8).
- No placeholders: all code blocks contain full code, no TODOs.
- Type consistency: `CONSOLIDATION_JOB_NAME` exported from `consolidation-job.ts`, imported in both scheduler and integration test. `SchedulerStateRepository` interface methods (`getLastRun`, `recordRun`) match across definition, impl, and callers. `CatchUpOptions` shape (`enabled`, `graceSeconds`) consistent between interface, server.ts wiring, and test instantiation.
