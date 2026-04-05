import type { MemoryRepository } from "../repositories/types.js";
import type { FlagService } from "./flag-service.js";
import type { AuditService } from "./audit-service.js";
import { logger } from "../utils/logger.js";

interface ConsolidationConfig {
  autoArchiveThreshold: number;
  flagThreshold: number;
  contradictionThreshold: number;
  verifyAfterDays: number;
}

export type ClassificationResult =
  | "auto_archive"
  | "flag_duplicate"
  | "flag_superseded"
  | "flag_contradiction"
  | "flag_override"
  | null;

/**
 * Classify a pair of memories based on similarity and scope relationship.
 * Pure function for testability.
 */
export function classifyPair(
  similarity: number,
  scopeRelation: "same scope" | "cross scope",
  isUserScoped: boolean,
  config: Omit<ConsolidationConfig, "verifyAfterDays">,
): ClassificationResult {
  if (similarity < config.contradictionThreshold) {
    return null;
  }

  // High similarity — potential duplicate
  if (similarity >= config.flagThreshold) {
    if (scopeRelation === "cross scope") {
      return "flag_superseded";
    }
    // Same scope
    if (similarity >= config.autoArchiveThreshold && !isUserScoped) {
      return "auto_archive";
    }
    return "flag_duplicate";
  }

  // Medium similarity (between contradiction and flag thresholds)
  if (scopeRelation === "cross scope") {
    return "flag_override";
  }
  return "flag_contradiction";
}

export interface ConsolidationResult {
  archived: number;
  flagged: number;
  errors: number;
}

export class ConsolidationService {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly flagService: FlagService,
    private readonly auditService: AuditService,
    private readonly projectId: string,
    private readonly config: ConsolidationConfig,
  ) {}

  /**
   * Run a full consolidation pass. Returns counts of actions taken.
   */
  async run(): Promise<ConsolidationResult> {
    const result: ConsolidationResult = { archived: 0, flagged: 0, errors: 0 };

    // Layer 1: Project-scope consistency
    try {
      const projectResult = await this.consolidateScope("project", null);
      result.archived += projectResult.archived;
      result.flagged += projectResult.flagged;
      result.errors += projectResult.errors;
    } catch (error) {
      logger.error("Consolidation Layer 1 (project) failed:", error);
      result.errors++;
    }

    // Layer 2: Per-workspace checks
    const workspaces = await this.getActiveWorkspaces();
    for (const workspaceId of workspaces) {
      try {
        const wsResult = await this.consolidateScope("workspace", workspaceId);
        result.archived += wsResult.archived;
        result.flagged += wsResult.flagged;
        result.errors += wsResult.errors;

        const crossResult = await this.crossScopeCheck(workspaceId);
        result.flagged += crossResult.flagged;
        result.errors += crossResult.errors;

        const userResult = await this.userScopeCheck(workspaceId);
        result.flagged += userResult.flagged;
        result.errors += userResult.errors;

        const verifyResult = await this.flagVerificationCandidates(workspaceId);
        result.flagged += verifyResult.flagged;
        result.errors += verifyResult.errors;
      } catch (error) {
        logger.error(
          `Consolidation Layer 2 (workspace ${workspaceId}) failed:`,
          error,
        );
        result.errors++;
      }
    }

    return result;
  }

  private async consolidateScope(
    scope: "project" | "workspace",
    workspaceId: string | null,
  ): Promise<ConsolidationResult> {
    const result: ConsolidationResult = { archived: 0, flagged: 0, errors: 0 };

    // Get all memories in this scope for content subset check
    const memoriesResult = await this.memoryRepo.list({
      project_id: this.projectId,
      workspace_id: workspaceId ?? undefined,
      scope,
      limit: 1000,
    });

    const active = memoriesResult.memories;
    if (active.length < 2) return result;

    const archivedIds = new Set<string>();

    // Tier 1a: Content subset check (normalized substring match)
    const normalized = active.map((m) =>
      m.content.toLowerCase().replace(/\s+/g, " ").trim(),
    );

    for (let i = 0; i < active.length; i++) {
      if (archivedIds.has(active[i].id)) continue;
      for (let j = 0; j < active.length; j++) {
        if (i === j || archivedIds.has(active[j].id)) continue;
        if (
          normalized[j].includes(normalized[i]) &&
          normalized[i].length < normalized[j].length
        ) {
          await this.memoryRepo.archive([active[i].id]);
          await this.auditService.logArchive(
            active[i].id,
            "consolidation",
            `Content subset of ${active[j].id}`,
          );
          await this.flagService.createFlag({
            memoryId: active[i].id,
            flagType: "duplicate",
            severity: "auto_resolved",
            details: {
              related_memory_id: active[j].id,
              reason: `Auto-archived: content is a subset of memory "${active[j].title}"`,
            },
          });
          archivedIds.add(active[i].id);
          result.archived++;
          break;
        }
      }
    }

    // Tier 1b + Tier 2: Pairwise embedding similarity
    const pairs = await this.memoryRepo.findPairwiseSimilar({
      projectId: this.projectId,
      workspaceId,
      scope,
      threshold: this.config.contradictionThreshold,
    });

    for (const pair of pairs) {
      if (
        archivedIds.has(pair.memory_a_id) ||
        archivedIds.has(pair.memory_b_id)
      ) {
        continue;
      }

      try {
        const classification = classifyPair(
          pair.similarity,
          "same scope",
          false,
          this.config,
        );

        if (classification === "auto_archive") {
          const olderMemoryId = pair.memory_b_id;
          await this.memoryRepo.archive([olderMemoryId]);
          await this.flagService.autoResolveByMemoryId(olderMemoryId);
          await this.auditService.logArchive(
            olderMemoryId,
            "consolidation",
            `Near-exact duplicate of ${pair.memory_a_id} (similarity: ${pair.similarity.toFixed(3)})`,
          );
          await this.flagService.createFlag({
            memoryId: olderMemoryId,
            flagType: "duplicate",
            severity: "auto_resolved",
            details: {
              related_memory_id: pair.memory_a_id,
              similarity: pair.similarity,
              reason: `Auto-archived: near-exact duplicate (similarity ${pair.similarity.toFixed(3)})`,
            },
          });
          archivedIds.add(olderMemoryId);
          result.archived++;
        } else if (classification === "flag_duplicate") {
          await this.flagService.createFlag({
            memoryId: pair.memory_b_id,
            flagType: "duplicate",
            severity: "needs_review",
            details: {
              related_memory_id: pair.memory_a_id,
              similarity: pair.similarity,
              reason: `Probable duplicate (similarity ${pair.similarity.toFixed(3)})`,
            },
          });
          result.flagged++;
        } else if (classification === "flag_contradiction") {
          await this.flagService.createFlag({
            memoryId: pair.memory_b_id,
            flagType: "contradiction",
            severity: "needs_review",
            details: {
              related_memory_id: pair.memory_a_id,
              similarity: pair.similarity,
              reason: `Possible contradiction (similarity ${pair.similarity.toFixed(3)})`,
            },
          });
          result.flagged++;
        }
      } catch (error) {
        logger.warn(
          `Consolidation action failed for pair ${pair.memory_a_id}/${pair.memory_b_id}:`,
          error,
        );
        result.errors++;
      }
    }

    return result;
  }

  private async getActiveWorkspaces(): Promise<string[]> {
    return this.memoryRepo.listDistinctWorkspaces(this.projectId);
  }

  private async crossScopeCheck(
    workspaceId: string,
  ): Promise<{ flagged: number; errors: number }> {
    let flagged = 0;
    let errors = 0;

    const wsMemories = await this.memoryRepo.listWithEmbeddings({
      projectId: this.projectId,
      workspaceId,
      scope: "workspace",
      limit: 500,
    });

    for (const wsMem of wsMemories) {
      try {
        const duplicates = await this.memoryRepo.findDuplicates({
          embedding: wsMem.embedding,
          projectId: this.projectId,
          workspaceId: null,
          scope: "project",
          userId: wsMem.author,
          threshold: this.config.contradictionThreshold,
        });

        for (const dup of duplicates) {
          const classification = classifyPair(
            dup.relevance,
            "cross scope",
            false,
            this.config,
          );

          if (
            classification === "flag_superseded" ||
            classification === "flag_override"
          ) {
            await this.flagService.createFlag({
              memoryId: wsMem.id,
              flagType:
                classification === "flag_superseded"
                  ? "superseded"
                  : "override",
              severity: "needs_review",
              details: {
                related_memory_id: dup.id,
                similarity: dup.relevance,
                reason:
                  classification === "flag_superseded"
                    ? `Workspace memory may duplicate project memory "${dup.title}" (similarity ${dup.relevance.toFixed(3)})`
                    : `Workspace memory may contradict project memory "${dup.title}" (similarity ${dup.relevance.toFixed(3)})`,
              },
            });
            flagged++;
          }
        }
      } catch (error) {
        logger.warn(`Cross-scope check failed for memory ${wsMem.id}:`, error);
        errors++;
      }
    }

    return { flagged, errors };
  }

  private async userScopeCheck(
    workspaceId: string,
  ): Promise<{ flagged: number; errors: number }> {
    let flagged = 0;
    let errors = 0;

    const userMemories = await this.memoryRepo.listWithEmbeddings({
      projectId: this.projectId,
      workspaceId,
      scope: "user",
      limit: 500,
    });

    for (const userMem of userMemories) {
      try {
        const wsDups = await this.memoryRepo.findDuplicates({
          embedding: userMem.embedding,
          projectId: this.projectId,
          workspaceId,
          scope: "workspace",
          userId: userMem.author,
          threshold: this.config.flagThreshold,
        });

        const projDups = await this.memoryRepo.findDuplicates({
          embedding: userMem.embedding,
          projectId: this.projectId,
          workspaceId: null,
          scope: "project",
          userId: userMem.author,
          threshold: this.config.flagThreshold,
        });

        const allDups = [...wsDups, ...projDups];
        for (const dup of allDups) {
          await this.flagService.createFlag({
            memoryId: userMem.id,
            flagType: "superseded",
            severity: "needs_review",
            details: {
              related_memory_id: dup.id,
              similarity: dup.relevance,
              reason: `User memory may be superseded by ${dup.scope}-scoped memory "${dup.title}" (similarity ${dup.relevance.toFixed(3)})`,
            },
          });
          flagged++;
        }
      } catch (error) {
        logger.warn(`User scope check failed for memory ${userMem.id}:`, error);
        errors++;
      }
    }

    return { flagged, errors };
  }

  private async flagVerificationCandidates(
    workspaceId: string,
  ): Promise<{ flagged: number; errors: number }> {
    let flagged = 0;
    let errors = 0;

    const threshold = this.config.verifyAfterDays;
    const staleResult = await this.memoryRepo.findStale({
      project_id: this.projectId,
      workspace_id: workspaceId,
      threshold_days: threshold,
      limit: 50,
    });

    for (const memory of staleResult.memories) {
      try {
        const existingFlags = await this.flagService.getFlagsByMemoryId(
          memory.id,
        );
        const hasOpenVerify = existingFlags.some(
          (f) => f.flag_type === "verify" && f.resolved_at === null,
        );
        if (hasOpenVerify) continue;

        await this.flagService.createFlag({
          memoryId: memory.id,
          flagType: "verify",
          severity: "needs_review",
          details: {
            reason: `Memory not verified in over ${threshold} days`,
          },
        });
        flagged++;
      } catch (error) {
        logger.warn(`Verify flag failed for memory ${memory.id}:`, error);
        errors++;
      }
    }

    return { flagged, errors };
  }
}
