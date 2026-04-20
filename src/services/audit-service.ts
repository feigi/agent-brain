import type { AuditRepository } from "../repositories/types.js";
import type { AuditEntry, AuditAction } from "../types/audit.js";
import { generateId } from "../utils/id.js";
import { logger } from "../utils/logger.js";

export class AuditService {
  constructor(
    private readonly auditRepo: AuditRepository,
    private readonly projectId: string,
  ) {}

  async log(
    memoryId: string,
    action: AuditAction,
    actor: string,
    reason?: string,
    diff?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditRepo.create({
        id: generateId(),
        project_id: this.projectId,
        memory_id: memoryId,
        action,
        actor,
        reason: reason ?? null,
        diff: diff ?? null,
        created_at: new Date(),
      });
    } catch (error) {
      // Best-effort: audit failure must not break the primary operation.
      // Reason-bearing creates (e.g. user-confirmed project scope) are the only
      // compliance record of that approval, so surface at error level with
      // enough context to reconstruct manually from logs.
      const ctx = `action=${action} memory=${memoryId}${reason ? ` reason="${reason}"` : ""}`;
      if (action === "created" && reason) {
        logger.error(`Audit log failed: ${ctx}`, error);
      } else {
        logger.warn(`Audit log failed: ${ctx}`, error);
      }
    }
  }

  async logCreate(
    memoryId: string,
    actor: string,
    reason?: string,
  ): Promise<void> {
    await this.log(memoryId, "created", actor, reason);
  }

  async logUpdate(
    memoryId: string,
    actor: string,
    diff: Record<string, unknown>,
  ): Promise<void> {
    await this.log(memoryId, "updated", actor, undefined, diff);
  }

  async logArchive(
    memoryId: string,
    actor: string,
    reason?: string,
  ): Promise<void> {
    await this.log(memoryId, "archived", actor, reason);
  }

  async logComment(memoryId: string, actor: string): Promise<void> {
    await this.log(memoryId, "commented", actor);
  }

  async getHistory(memoryId: string): Promise<AuditEntry[]> {
    return this.auditRepo.findByMemoryId(memoryId);
  }
}
