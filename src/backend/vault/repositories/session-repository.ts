import { join } from "node:path";
import type { SessionRepository } from "../../../repositories/types.js";
import { config } from "../../../config.js";
import { withFileLock } from "../io/lock.js";
import {
  readJson,
  writeJsonAtomic,
  writeJsonExclusive,
} from "../io/json-fs.js";
import { safeSegment } from "../io/paths.js";

export interface VaultSessionConfig {
  root: string;
}

interface SessionRecord {
  id: string;
  user_id: string;
  project_id: string;
  workspace_id: string;
  budget_used: number;
}

function sessionPath(id: string): string {
  return `_sessions/${safeSegment(id, "session id")}.json`;
}

export class VaultSessionRepository implements SessionRepository {
  constructor(private readonly cfg: VaultSessionConfig) {}

  async createSession(
    id: string,
    userId: string,
    projectId: string,
    workspaceId: string,
  ): Promise<void> {
    const rel = sessionPath(id);
    const record: SessionRecord = {
      id,
      user_id: userId,
      project_id: projectId,
      workspace_id: workspaceId,
      budget_used: 0,
    };
    // O_EXCL matches pg's PK — concurrent same-id creates give exactly
    // one winner; the loser gets the thrown "already exists" error.
    try {
      await writeJsonExclusive(this.cfg.root, rel, record);
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "EEXIST"
      )
        throw new Error(`session already exists: ${id}`, { cause: err });
      throw err;
    }
  }

  async getBudget(
    sessionId: string,
  ): Promise<{ used: number; limit: number } | null> {
    const record = await readJson<SessionRecord>(
      this.cfg.root,
      sessionPath(sessionId),
    );
    if (!record) return null;
    return {
      used: record.budget_used,
      limit: config.writeBudgetPerSession,
    };
  }

  async incrementBudgetUsed(
    sessionId: string,
    limit: number,
  ): Promise<{ used: number; exceeded: boolean }> {
    const rel = sessionPath(sessionId);
    // Short-circuit unknown sessions without creating a placeholder file.
    // Mirrors pg's UPDATE ... WHERE id=? returning 0 rows → exceeded.
    const exists = await readJson<SessionRecord>(this.cfg.root, rel);
    if (!exists) return { used: limit, exceeded: true };

    const abs = join(this.cfg.root, rel);
    return await withFileLock(abs, async () => {
      const record = await readJson<SessionRecord>(this.cfg.root, rel);
      // The row must exist — we checked above outside the lock, and
      // session files are never deleted. A null here indicates corruption.
      if (!record)
        throw new Error(`session record vanished under lock: ${sessionId}`);
      if (record.budget_used >= limit) {
        return { used: record.budget_used, exceeded: true };
      }
      const next: SessionRecord = {
        ...record,
        budget_used: record.budget_used + 1,
      };
      await writeJsonAtomic(this.cfg.root, rel, next);
      return { used: next.budget_used, exceeded: false };
    });
  }

  async findById(sessionId: string): Promise<{
    id: string;
    user_id: string;
    project_id: string;
    workspace_id: string;
    budget_used: number;
  } | null> {
    return await readJson<SessionRecord>(this.cfg.root, sessionPath(sessionId));
  }
}
