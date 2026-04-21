import { join } from "node:path";
import type { AuditEntry } from "../../../types/audit.js";
import type { AuditRepository } from "../../../repositories/types.js";
import { withFileLock } from "../io/lock.js";
import { appendJsonLine, readJsonLines } from "../io/json-fs.js";
import { ensureParentDir } from "../io/vault-fs.js";
import { safeSegment } from "../io/paths.js";

export interface VaultAuditConfig {
  root: string;
}

interface AuditRecord {
  id: string;
  project_id: string;
  memory_id: string;
  action: AuditEntry["action"];
  actor: string;
  reason: string | null;
  diff: Record<string, unknown> | null;
  created_at: string;
}

export class VaultAuditRepository implements AuditRepository {
  constructor(private readonly cfg: VaultAuditConfig) {}

  async create(entry: AuditEntry): Promise<void> {
    const rel = auditPath(entry.memory_id);
    const abs = join(this.cfg.root, rel);
    // Lock serializes concurrent writers cross-platform; don't rely
    // on O_APPEND atomicity (which only holds below PIPE_BUF on POSIX).
    await ensureParentDir(abs);
    await withFileLock(abs, async () => {
      const record: AuditRecord = {
        id: entry.id,
        project_id: entry.project_id,
        memory_id: entry.memory_id,
        action: entry.action,
        actor: entry.actor,
        reason: entry.reason,
        diff: entry.diff,
        created_at: entry.created_at.toISOString(),
      };
      await appendJsonLine(this.cfg.root, rel, record);
    });
  }

  async findByMemoryId(memoryId: string): Promise<AuditEntry[]> {
    const records = await readJsonLines<AuditRecord>(
      this.cfg.root,
      auditPath(memoryId),
    );
    const entries = records.map((r) => {
      const created = new Date(r.created_at);
      if (Number.isNaN(created.getTime()))
        throw new Error(
          `audit entry ${r.id} has invalid created_at: ${r.created_at}`,
        );
      return {
        id: r.id,
        project_id: r.project_id,
        memory_id: r.memory_id,
        action: r.action,
        actor: r.actor,
        reason: r.reason,
        diff: r.diff,
        created_at: created,
      } satisfies AuditEntry;
    });
    return entries.sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime(),
    );
  }
}

function auditPath(memoryId: string): string {
  return `_audit/${safeSegment(memoryId, "memory_id")}.jsonl`;
}
