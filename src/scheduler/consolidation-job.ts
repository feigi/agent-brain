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

  async execute(): Promise<void> {
    if (this.running) {
      logger.warn("Consolidation job already running, skipping");
      return;
    }

    // Acquire advisory lock to prevent concurrent runs across server instances
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

    try {
      const result = await this.consolidationService.run();
      const elapsed = Date.now() - start;
      logger.info(
        `Consolidation job completed in ${elapsed}ms: ` +
          `archived=${result.archived}, flagged=${result.flagged}, errors=${result.errors}`,
      );
      await this.schedulerStateRepo.recordRun(
        CONSOLIDATION_JOB_NAME,
        new Date(start),
      );
    } catch (error) {
      logger.error("Consolidation job failed:", error);
    } finally {
      await this.db.execute(
        sql`SELECT pg_advisory_unlock(${CONSOLIDATION_LOCK_ID})`,
      );
      this.running = false;
    }
  }
}
