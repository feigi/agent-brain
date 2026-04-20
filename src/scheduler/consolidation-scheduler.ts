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
 * graceSeconds protects against re-firing when the server restarts seconds
 * after a successful run — clock skew / commit ordering can make `lastRun`
 * appear a hair before `prevTick`.
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
