import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { ConsolidationService } from "../services/consolidation-service.js";
import type { SchedulerStateRepository } from "../repositories/types.js";
import type { SchedulerJobName } from "../db/schema.js";
import { logger } from "../utils/logger.js";

/** PostgreSQL advisory lock ID for consolidation job exclusivity across server instances */
const CONSOLIDATION_LOCK_ID = 42001;

export const CONSOLIDATION_JOB_NAME: SchedulerJobName = "consolidation";

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

  async execute(): Promise<void> {
    if (this.running) {
      logger.warn("Consolidation job already running, skipping");
      return;
    }

    // Cross-instance mutual exclusion. Same-process overlap is prevented by the
    // `running` guard above — this only matters when a peer server is holding the lock.
    const lockResult = await this.db.execute(
      sql`SELECT pg_try_advisory_lock(${CONSOLIDATION_LOCK_ID}) AS acquired`,
    );
    const rows = lockResult as unknown as Array<Record<string, unknown>>;
    const acquired = rows[0]?.acquired;
    if (!acquired) {
      logger.info(
        "Consolidation job skipped — another instance holds the lock",
      );
      return;
    }

    this.running = true;
    const start = Date.now();
    logger.info("Consolidation job started");

    let jobSucceeded = false;
    try {
      try {
        const result = await this.consolidationService.run();
        const elapsed = Date.now() - start;
        logger.info(
          `Consolidation job completed in ${elapsed}ms: ` +
            `archived=${result.archived}, flagged=${result.flagged}, errors=${result.errors}`,
        );
        jobSucceeded = true;
      } catch (error) {
        logger.error("Consolidation job failed:", error);
      }

      if (jobSucceeded) {
        try {
          await this.schedulerStateRepo.recordRun(
            CONSOLIDATION_JOB_NAME,
            new Date(start),
          );
        } catch (error) {
          // Job ran successfully; only bookkeeping failed. Do NOT mark the job failed.
          // Next startup will see stale last_run_at and trigger a spurious catch-up.
          logger.error(
            `Consolidation recordRun failed — job succeeded but last_run_at not persisted. ` +
              `Next startup may re-run catch-up. Manual recovery: ` +
              `UPDATE scheduler_state SET last_run_at = '${new Date(start).toISOString()}' ` +
              `WHERE job_name = '${CONSOLIDATION_JOB_NAME}'.`,
            error,
          );
        }
      }
    } finally {
      try {
        await this.db.execute(
          sql`SELECT pg_advisory_unlock(${CONSOLIDATION_LOCK_ID})`,
        );
      } catch (unlockErr) {
        logger.error(
          "Consolidation advisory unlock failed — lock will release on session end:",
          unlockErr,
        );
      } finally {
        this.running = false;
      }
    }
  }
}
