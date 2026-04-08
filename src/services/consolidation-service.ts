import type { MemoryRepository } from "../repositories/types.js";
import type { FlagService } from "./flag-service.js";
import type { AuditService } from "./audit-service.js";
import type { RelationshipService } from "./relationship-service.js";
import { SYSTEM_ACTOR } from "./relationship-service.js";
import type { FlagResponse } from "../types/flag.js";
import type { FlagType, FlagSeverity } from "../types/flag.js";
import { logger } from "../utils/logger.js";

interface ConsolidationConfig {
  autoArchiveThreshold: number;
  flagThreshold: number;
  verifyAfterDays: number;
}

export type ClassificationResult =
  | "auto_archive"
  | "flag_duplicate"
  | "flag_superseded"
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
  if (similarity < config.flagThreshold) {
    return null;
  }

  if (scopeRelation === "cross scope") {
    return "flag_superseded";
  }
  // Same scope
  if (similarity >= config.autoArchiveThreshold && !isUserScoped) {
    return "auto_archive";
  }
  return "flag_duplicate";
}

export interface ConsolidationResult {
  archived: number;
  flagged: number;
  errors: number;
  flags: FlagResponse[];
}

type SubResult = { flagged: number; errors: number; flags: FlagResponse[] };

export class ConsolidationService {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly flagService: FlagService,
    private readonly auditService: AuditService,
    private readonly projectId: string,
    private readonly config: ConsolidationConfig,
    private readonly relationshipService?: RelationshipService,
  ) {}

  private async tryArchiveRelationships(memoryId: string): Promise<void> {
    if (!this.relationshipService) return;
    try {
      await this.relationshipService.archiveByMemoryId(memoryId);
    } catch (error) {
      logger.error(
        `Failed to archive relationships for auto-archived memory ${memoryId}:`,
        error,
      );
    }
  }

  /**
   * Create a relationship (best-effort) and then a flag with the relationship_id.
   * In all consolidation cases, the flagged memory is the relationship target
   * and the related memory is the source.
   */
  private async createRelationshipAndFlag(
    relInput: {
      sourceId: string;
      targetId: string;
      type: string;
      confidence: number;
    },
    flagInput: {
      flagType: FlagType;
      severity: FlagSeverity;
      similarity?: number;
      reason: string;
    },
  ): Promise<import("../types/flag.js").Flag> {
    let relationshipId: string | undefined;
    if (this.relationshipService) {
      try {
        const rel = await this.relationshipService.createInternal({
          ...relInput,
          userId: SYSTEM_ACTOR,
          createdVia: SYSTEM_ACTOR,
        });
        relationshipId = rel.id;
      } catch (error) {
        logger.error(
          `Failed to create ${relInput.type} relationship ${relInput.sourceId} → ${relInput.targetId}:`,
          error,
        );
      }
    }
    return this.flagService.createFlag({
      memoryId: relInput.targetId,
      flagType: flagInput.flagType,
      severity: flagInput.severity,
      details: {
        related_memory_id: relInput.sourceId,
        relationship_id: relationshipId,
        similarity: flagInput.similarity,
        reason: flagInput.reason,
      },
    });
  }

  /**
   * Run a full consolidation pass. Returns counts and enriched flags.
   */
  async run(): Promise<ConsolidationResult> {
    const result: ConsolidationResult = {
      archived: 0,
      flagged: 0,
      errors: 0,
      flags: [],
    };

    // Layer 1: Project-scope consistency
    try {
      const projectResult = await this.consolidateScope("project", null);
      result.archived += projectResult.archived;
      result.flagged += projectResult.flagged;
      result.errors += projectResult.errors;
      result.flags.push(...projectResult.flags);
    } catch (error) {
      logger.error("Consolidation Layer 1 (project) failed:", error);
      result.errors++;
    }

    // Layer 2: Per-workspace checks
    const workspaces = await this.getActiveWorkspaces();
    for (const workspaceId of workspaces) {
      try {
        const [wsResult, crossResult, userResult, verifyResult] =
          await Promise.all([
            this.consolidateScope("workspace", workspaceId),
            this.crossScopeCheck(workspaceId),
            this.userScopeCheck(workspaceId),
            this.flagVerificationCandidates(workspaceId),
          ]);

        result.archived += wsResult.archived;
        result.flagged +=
          wsResult.flagged +
          crossResult.flagged +
          userResult.flagged +
          verifyResult.flagged;
        result.errors +=
          wsResult.errors +
          crossResult.errors +
          userResult.errors +
          verifyResult.errors;
        result.flags.push(
          ...wsResult.flags,
          ...crossResult.flags,
          ...userResult.flags,
          ...verifyResult.flags,
        );
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
    const result: ConsolidationResult = {
      archived: 0,
      flagged: 0,
      errors: 0,
      flags: [],
    };

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
            SYSTEM_ACTOR,
            `Content subset of ${active[j].id}`,
          );
          await this.tryArchiveRelationships(active[i].id);
          await this.createRelationshipAndFlag(
            {
              sourceId: active[j].id,
              targetId: active[i].id,
              type: "duplicates",
              confidence: 1.0,
            },
            {
              flagType: "duplicate",
              severity: "auto_resolved",
              reason: `Auto-archived: content is a subset of memory "${active[j].title}"`,
            },
          );
          archivedIds.add(active[i].id);
          result.archived++;
          break;
        }
      }
    }

    // Build a lookup for enriching flags from pairwise similarity
    const memoryById = new Map(active.map((m) => [m.id, m]));

    // Tier 1b + Tier 2: Pairwise embedding similarity
    const pairs = await this.memoryRepo.findPairwiseSimilar({
      projectId: this.projectId,
      workspaceId,
      scope,
      threshold: this.config.flagThreshold,
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
            SYSTEM_ACTOR,
            `Near-exact duplicate of ${pair.memory_a_id} (similarity: ${pair.similarity.toFixed(3)})`,
          );
          await this.tryArchiveRelationships(olderMemoryId);
          await this.createRelationshipAndFlag(
            {
              sourceId: pair.memory_a_id,
              targetId: olderMemoryId,
              type: "duplicates",
              confidence: pair.similarity,
            },
            {
              flagType: "duplicate",
              severity: "auto_resolved",
              similarity: pair.similarity,
              reason: `Auto-archived: near-exact duplicate (similarity ${pair.similarity.toFixed(3)})`,
            },
          );
          archivedIds.add(olderMemoryId);
          result.archived++;
        } else if (classification === "flag_duplicate") {
          const alreadyFlagged = await this.flagService.hasOpenFlag(
            pair.memory_b_id,
            "duplicate",
            pair.memory_a_id,
          );
          if (alreadyFlagged) continue;

          const flag = await this.createRelationshipAndFlag(
            {
              sourceId: pair.memory_a_id,
              targetId: pair.memory_b_id,
              type: "duplicates",
              confidence: pair.similarity,
            },
            {
              flagType: "duplicate",
              severity: "needs_review",
              similarity: pair.similarity,
              reason: `Probable duplicate (similarity ${pair.similarity.toFixed(3)})`,
            },
          );
          const mem = memoryById.get(pair.memory_b_id);
          const rel = memoryById.get(pair.memory_a_id);
          if (mem) {
            result.flags.push({
              flag_id: flag.id,
              flag_type: flag.flag_type,
              memory: {
                id: mem.id,
                title: mem.title,
                content: mem.content,
                scope: mem.scope,
              },
              related_memory: rel
                ? {
                    id: rel.id,
                    title: rel.title,
                    content: rel.content,
                    scope: rel.scope,
                  }
                : null,
              reason: flag.details.reason,
            });
          }
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

  private async crossScopeCheck(workspaceId: string): Promise<SubResult> {
    const subResult: SubResult = { flagged: 0, errors: 0, flags: [] };

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
          threshold: this.config.flagThreshold,
        });

        for (const dup of duplicates) {
          if (dup.relevance < this.config.flagThreshold) continue;

          const alreadyFlagged = await this.flagService.hasOpenFlag(
            wsMem.id,
            "superseded",
            dup.id,
          );
          if (alreadyFlagged) continue;

          const flag = await this.createRelationshipAndFlag(
            {
              sourceId: dup.id,
              targetId: wsMem.id,
              type: "overrides",
              confidence: dup.relevance,
            },
            {
              flagType: "superseded",
              severity: "needs_review",
              similarity: dup.relevance,
              reason: `Workspace memory may duplicate project memory "${dup.title}" (similarity ${dup.relevance.toFixed(3)})`,
            },
          );
          subResult.flags.push({
            flag_id: flag.id,
            flag_type: flag.flag_type,
            memory: {
              id: wsMem.id,
              title: wsMem.title,
              content: wsMem.content,
              scope: wsMem.scope,
            },
            related_memory: {
              id: dup.id,
              title: dup.title,
              content: "",
              scope: dup.scope,
            },
            reason: flag.details.reason,
          });
          subResult.flagged++;
        }
      } catch (error) {
        logger.warn(`Cross-scope check failed for memory ${wsMem.id}:`, error);
        subResult.errors++;
      }
    }

    return subResult;
  }

  private async userScopeCheck(workspaceId: string): Promise<SubResult> {
    const subResult: SubResult = { flagged: 0, errors: 0, flags: [] };

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
          const alreadyFlagged = await this.flagService.hasOpenFlag(
            userMem.id,
            "superseded",
            dup.id,
          );
          if (alreadyFlagged) continue;

          const flag = await this.createRelationshipAndFlag(
            {
              sourceId: dup.id,
              targetId: userMem.id,
              type: "overrides",
              confidence: dup.relevance,
            },
            {
              flagType: "superseded",
              severity: "needs_review",
              similarity: dup.relevance,
              reason: `User memory may be superseded by ${dup.scope}-scoped memory "${dup.title}" (similarity ${dup.relevance.toFixed(3)})`,
            },
          );
          subResult.flags.push({
            flag_id: flag.id,
            flag_type: flag.flag_type,
            memory: {
              id: userMem.id,
              title: userMem.title,
              content: userMem.content,
              scope: userMem.scope,
            },
            related_memory: {
              id: dup.id,
              title: dup.title,
              content: "",
              scope: dup.scope,
            },
            reason: flag.details.reason,
          });
          subResult.flagged++;
        }
      } catch (error) {
        logger.warn(`User scope check failed for memory ${userMem.id}:`, error);
        subResult.errors++;
      }
    }

    return subResult;
  }

  private async flagVerificationCandidates(
    workspaceId: string,
  ): Promise<SubResult> {
    const subResult: SubResult = { flagged: 0, errors: 0, flags: [] };

    const threshold = this.config.verifyAfterDays;
    const staleResult = await this.memoryRepo.findStale({
      project_id: this.projectId,
      workspace_id: workspaceId,
      threshold_days: threshold,
      limit: 50,
    });

    for (const memory of staleResult.memories) {
      try {
        const hasOpenVerify = await this.flagService.hasOpenFlag(
          memory.id,
          "verify",
        );
        if (hasOpenVerify) continue;

        const flag = await this.flagService.createFlag({
          memoryId: memory.id,
          flagType: "verify",
          severity: "needs_review",
          details: {
            reason: `Memory not verified in over ${threshold} days`,
          },
        });
        subResult.flags.push({
          flag_id: flag.id,
          flag_type: flag.flag_type,
          memory: {
            id: memory.id,
            title: memory.title,
            content: memory.content,
            scope: memory.scope,
          },
          related_memory: null,
          reason: flag.details.reason,
        });
        subResult.flagged++;
      } catch (error) {
        logger.warn(`Verify flag failed for memory ${memory.id}:`, error);
        subResult.errors++;
      }
    }

    return subResult;
  }
}
