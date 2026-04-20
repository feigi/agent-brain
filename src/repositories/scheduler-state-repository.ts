import { eq, lt } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { schedulerState, type SchedulerJobName } from "../db/schema.js";
import type { SchedulerStateRepository } from "./types.js";

export class DrizzleSchedulerStateRepository implements SchedulerStateRepository {
  constructor(private readonly db: Database) {}

  async getLastRun(jobName: SchedulerJobName): Promise<Date | null> {
    const rows = await this.db
      .select({ last_run_at: schedulerState.last_run_at })
      .from(schedulerState)
      .where(eq(schedulerState.job_name, jobName))
      .limit(1);

    return rows[0]?.last_run_at ?? null;
  }

  async recordRun(jobName: SchedulerJobName, runAt: Date): Promise<void> {
    // Monotonic: never regress last_run_at on late-arriving writes.
    await this.db
      .insert(schedulerState)
      .values({ job_name: jobName, last_run_at: runAt })
      .onConflictDoUpdate({
        target: schedulerState.job_name,
        set: { last_run_at: runAt },
        setWhere: lt(schedulerState.last_run_at, runAt),
      });
  }
}
