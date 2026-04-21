import { join } from "node:path";
import type { SessionTrackingRepository } from "../../../repositories/types.js";
import { withFileLock } from "../io/lock.js";
import { readJson, writeJsonAtomic } from "../io/json-fs.js";
import { ensureFileExists } from "../io/vault-fs.js";
import { safeSegment } from "../io/paths.js";

export interface VaultSessionTrackingConfig {
  root: string;
}

interface TrackingRecord {
  last_session_at: string;
}

function trackingPath(
  userId: string,
  workspaceId: string,
  projectId: string,
): string {
  return `_session-tracking/${safeSegment(userId, "userId")}/${safeSegment(
    workspaceId,
    "workspaceId",
  )}/${safeSegment(projectId, "projectId")}.json`;
}

export class VaultSessionTrackingRepository implements SessionTrackingRepository {
  constructor(private readonly cfg: VaultSessionTrackingConfig) {}

  async upsert(
    userId: string,
    projectId: string,
    workspaceId: string,
  ): Promise<Date | null> {
    const rel = trackingPath(userId, workspaceId, projectId);
    const abs = join(this.cfg.root, rel);
    await ensureFileExists(abs);
    return await withFileLock(abs, async () => {
      const prev = await readJson<TrackingRecord>(this.cfg.root, rel);
      const previousSession = prev ? parseIso(prev.last_session_at, rel) : null;
      const now = new Date();
      await writeJsonAtomic(this.cfg.root, rel, {
        last_session_at: now.toISOString(),
      });
      return previousSession;
    });
  }
}

function parseIso(raw: string, rel: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()))
    throw new Error(
      `session-tracking ${rel} has invalid last_session_at: ${raw}`,
    );
  return d;
}
