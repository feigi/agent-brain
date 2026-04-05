import cron from "node-cron";
import type { ConsolidationJob } from "./consolidation-job.js";
import { logger } from "../utils/logger.js";

export class ConsolidationScheduler {
  private task: cron.ScheduledTask | null = null;

  constructor(
    private readonly job: ConsolidationJob,
    private readonly cronExpression: string,
  ) {}

  start(): void {
    if (!cron.validate(this.cronExpression)) {
      logger.error(
        `Invalid cron expression: ${this.cronExpression}, scheduler not started`,
      );
      return;
    }

    this.task = cron.schedule(this.cronExpression, () => {
      this.job.execute();
    });

    logger.info(
      `Consolidation scheduler started with cron: ${this.cronExpression}`,
    );
  }

  async stop(): Promise<void> {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }

    // Wait for running job to finish
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
