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
