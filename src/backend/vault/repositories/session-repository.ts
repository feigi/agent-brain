import { join } from "node:path";
import type { SessionRepository } from "../../../repositories/types.js";
import { config } from "../../../config.js";
import { withFileLock } from "../io/lock.js";
import { readJson, writeJsonAtomic } from "../io/json-fs.js";
import { ensureFileExists } from "../io/vault-fs.js";

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

const UNSAFE_SEGMENT = /[/\\]|^\.\.?$|\0/;

function sessionPath(id: string): string {
  if (id.length === 0 || UNSAFE_SEGMENT.test(id))
    throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  return `_sessions/${id}.json`;
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
    // pg has a PK on id — writeJsonAtomic would silently overwrite.
    // Reject a pre-existing session so callers see a consistent error.
    const existing = await readJson<SessionRecord>(this.cfg.root, rel);
    if (existing !== null) throw new Error(`session already exists: ${id}`);
    await writeJsonAtomic(this.cfg.root, rel, record);
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
    const abs = join(this.cfg.root, rel);
    await ensureFileExists(abs);
    return await withFileLock(abs, async () => {
      const record = await readJson<SessionRecord>(this.cfg.root, rel);
      if (!record) {
        // Pre-existing file was empty or unreadable — mirror pg's
        // "session not found" path by returning `exceeded: true` with
        // used === limit so the caller short-circuits.
        return { used: limit, exceeded: true };
      }
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
    const record = await readJson<SessionRecord>(
      this.cfg.root,
      sessionPath(sessionId),
    );
    return record ?? null;
  }
}
