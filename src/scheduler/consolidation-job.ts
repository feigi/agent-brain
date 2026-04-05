import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { ConsolidationService } from "../services/consolidation-service.js";
import { logger } from "../utils/logger.js";

export class ConsolidationJob {
  private running = false;

  constructor(
    private readonly consolidationService: ConsolidationService,
    private readonly db: Database,
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
    const LOCK_ID = 42001;
    const lockResult = await this.db.execute(
      sql`SELECT pg_try_advisory_lock(${LOCK_ID}) AS acquired`,
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
    } catch (error) {
      logger.error("Consolidation job failed:", error);
    } finally {
      await this.db.execute(sql`SELECT pg_advisory_unlock(${LOCK_ID})`);
      this.running = false;
    }
  }
}
