import cron from "node-cron";
import cronParser from "cron-parser";
import type { ConsolidationJob } from "./consolidation-job.js";
import { CONSOLIDATION_JOB_NAME } from "./consolidation-job.js";
import type { SchedulerStateRepository } from "../repositories/types.js";
import { logger } from "../utils/logger.js";

export interface CatchUpOptions {
  readonly enabled: boolean;
  readonly graceSeconds: number;
}

/**
 * Compute the most recent scheduled tick strictly before `now`. Throws if the
 * cron expression cannot be parsed — callers validate at construction time.
 */
export function getPrevTick(cronExpression: string, now: Date): Date {
  const interval = cronParser.parseExpression(cronExpression, {
    currentDate: now,
  });
  return interval.prev().toDate();
}

/**
 * Decide whether a catch-up run is needed.
 *
 * graceSeconds protects against re-firing when the server restarts seconds
 * after a successful run — clock skew / commit ordering can make `lastRun`
 * appear a hair before `prevTick`.
 */
export function shouldCatchUp(
  prevTick: Date,
  lastRun: Date | null,
  graceSeconds: number,
): boolean {
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
  ) {
    if (!cron.validate(cronExpression)) {
      throw new Error(
        `Invalid cron expression: "${cronExpression}". ` +
          `Set CONSOLIDATION_CRON to a valid expression or disable with CONSOLIDATION_ENABLED=false.`,
      );
    }
    // Defense-in-depth: node-cron and cron-parser have slightly different grammars.
    // Reject at construction if cron-parser cannot parse it either.
    try {
      getPrevTick(cronExpression, new Date());
    } catch (error) {
      throw new Error(
        `Cron expression "${cronExpression}" accepted by node-cron but not cron-parser: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  async start(): Promise<void> {
    if (this.catchUp.enabled) {
      await this.runCatchUpIfNeeded();
    }

    this.task = cron.schedule(this.cronExpression, () => {
      this.job.execute().catch((error) => {
        logger.error(
          `Consolidation scheduled-tick invocation failed (job=${CONSOLIDATION_JOB_NAME}):`,
          error,
        );
      });
    });

    logger.info(
      `Consolidation scheduler started with cron: ${this.cronExpression}`,
    );
  }

  private async runCatchUpIfNeeded(): Promise<void> {
    let lastRun: Date | null;
    try {
      lastRun = await this.schedulerStateRepo.getLastRun(
        CONSOLIDATION_JOB_NAME,
      );
    } catch (error) {
      // Transient DB error at boot. Skip catch-up; scheduled ticks still register below.
      logger.error(
        `Consolidation catch-up skipped — getLastRun(${CONSOLIDATION_JOB_NAME}) failed:`,
        error,
      );
      return;
    }

    const prevTick = getPrevTick(this.cronExpression, new Date());
    if (!shouldCatchUp(prevTick, lastRun, this.catchUp.graceSeconds)) {
      return;
    }

    logger.info(
      `Consolidation catch-up triggered on startup (last_run=${
        lastRun?.toISOString() ?? "never"
      }, prev_tick=${prevTick.toISOString()})`,
    );
    // Fire-and-forget: catch-up can be long-running; start() must return so the
    // caller can register the recurring cron tick below without blocking on it.
    this.job.execute().catch((error) => {
      logger.error(
        `Consolidation catch-up failed (job=${CONSOLIDATION_JOB_NAME}, trigger=catchup) — manual investigation required:`,
        error,
      );
    });
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
