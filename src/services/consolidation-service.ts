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
   * Stub implementation — completed in Task 13.
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

  // Stub methods — completed in Task 13
  private async consolidateScope(
    _scope: "project" | "workspace", // eslint-disable-line @typescript-eslint/no-unused-vars
    _workspaceId: string | null, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<ConsolidationResult> {
    return { archived: 0, flagged: 0, errors: 0 };
  }

  private async getActiveWorkspaces(): Promise<string[]> {
    return [];
  }

  private async crossScopeCheck(
    _workspaceId: string, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<{ flagged: number; errors: number }> {
    return { flagged: 0, errors: 0 };
  }

  private async userScopeCheck(
    _workspaceId: string, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<{ flagged: number; errors: number }> {
    return { flagged: 0, errors: 0 };
  }

  private async flagVerificationCandidates(
    _workspaceId: string, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<{ flagged: number; errors: number }> {
    return { flagged: 0, errors: 0 };
  }
}
