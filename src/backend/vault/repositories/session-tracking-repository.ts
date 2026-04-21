import { join } from "node:path";
import type { SessionTrackingRepository } from "../../../repositories/types.js";
import { withFileLock } from "../io/lock.js";
import { readJson, writeJsonAtomic } from "../io/json-fs.js";
import { ensureFileExists } from "../io/vault-fs.js";

export interface VaultSessionTrackingConfig {
  root: string;
}

interface TrackingRecord {
  last_session_at: string;
}

// Segments interpolated into the tracking path must not contain path
// separators or traversal tokens — otherwise a crafted user_id could
// escape the tracking directory.
const UNSAFE_SEGMENT = /[/\\]|^\.\.?$|\0/;

function safeSegment(value: string, name: string): string {
  if (value.length === 0 || UNSAFE_SEGMENT.test(value))
    throw new Error(`invalid ${name}: ${JSON.stringify(value)}`);
  return value;
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
      const previousSession = prev
        ? parseIsoOrNull(prev.last_session_at)
        : null;
      const now = new Date();
      await writeJsonAtomic(this.cfg.root, rel, {
        last_session_at: now.toISOString(),
      });
      return previousSession;
    });
  }
}

function parseIsoOrNull(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
