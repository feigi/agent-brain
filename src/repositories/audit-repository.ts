import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { auditLog } from "../db/schema.js";
import type { AuditEntry } from "../types/audit.js";
import type { AuditRepository } from "./types.js";

export class DrizzleAuditRepository implements AuditRepository {
  constructor(private readonly db: Database) {}

  async create(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      id: entry.id,
      project_id: entry.project_id,
      memory_id: entry.memory_id,
      action: entry.action,
      actor: entry.actor,
      reason: entry.reason,
      diff: entry.diff,
    });
  }

  async findByMemoryId(memoryId: string): Promise<AuditEntry[]> {
    return await this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.memory_id, memoryId))
      .orderBy(desc(auditLog.created_at));
  }
}
