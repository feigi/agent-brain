import { join } from "node:path";
import type { SchedulerStateRepository } from "../../../repositories/types.js";
import type { SchedulerJobName } from "../../../db/schema.js";
import { withFileLock } from "../io/lock.js";
import { readJson, writeJsonAtomic } from "../io/json-fs.js";
import { ensureFileExists } from "../io/vault-fs.js";

export interface VaultSchedulerStateConfig {
  root: string;
}

const STATE_PATH = "_scheduler-state.json";

type StateMap = Record<string, string>;

export class VaultSchedulerStateRepository implements SchedulerStateRepository {
  constructor(private readonly cfg: VaultSchedulerStateConfig) {}

  async getLastRun(jobName: SchedulerJobName): Promise<Date | null> {
    const map = await readJson<StateMap>(this.cfg.root, STATE_PATH);
    const raw = map?.[jobName];
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime()))
      throw new Error(
        `scheduler-state ${jobName} has invalid timestamp: ${raw}`,
      );
    return d;
  }

  async recordRun(jobName: SchedulerJobName, runAt: Date): Promise<void> {
    const abs = join(this.cfg.root, STATE_PATH);
    // proper-lockfile requires the target file to exist.
    await ensureFileExists(abs);
    await withFileLock(abs, async () => {
      const current =
        (await readJson<StateMap>(this.cfg.root, STATE_PATH)) ?? {};
      const existing = current[jobName];
      // Monotonic: never regress last_run_at. Matches pg `setWhere lt(...)`.
      if (existing) {
        const prev = new Date(existing);
        if (!Number.isNaN(prev.getTime()) && prev.getTime() >= runAt.getTime())
          return;
      }
      current[jobName] = runAt.toISOString();
      await writeJsonAtomic(this.cfg.root, STATE_PATH, current);
    });
  }
}
