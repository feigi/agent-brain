import type { FlagRepository } from "../repositories/types.js";
import type { AuditService } from "./audit-service.js";
import type {
  Flag,
  FlagType,
  FlagSeverity,
  FlagResolution,
} from "../types/flag.js";
import { generateId } from "../utils/id.js";
import { NotFoundError } from "../utils/errors.js";

interface CreateFlagInput {
  memoryId: string;
  flagType: FlagType;
  severity: FlagSeverity;
  details: {
    related_memory_id?: string;
    relationship_id?: string;
    similarity?: number;
    reason: string;
  };
}

export class FlagService {
  constructor(
    private readonly flagRepo: FlagRepository,
    private readonly auditService: AuditService,
    private readonly projectId: string,
  ) {}

  async createFlag(input: CreateFlagInput): Promise<Flag> {
    const flag: Flag = {
      id: generateId(),
      project_id: this.projectId,
      memory_id: input.memoryId,
      flag_type: input.flagType,
      severity: input.severity,
      details: input.details,
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
    };

    const created = await this.flagRepo.create(flag);

    await this.auditService.log(
      input.memoryId,
      "flagged",
      "consolidation",
      input.details.reason,
      {
        flag_type: input.flagType,
        severity: input.severity,
        details: input.details,
      },
    );

    return created;
  }

  async resolveFlag(
    flagId: string,
    userId: string,
    resolution: FlagResolution,
  ): Promise<Flag | null> {
    const resolved = await this.flagRepo.resolve(flagId, userId, resolution);
    if (!resolved) {
      throw new NotFoundError("Flag", flagId);
    }
    return resolved;
  }

  async getOpenFlags(workspaceId: string, limit: number): Promise<Flag[]> {
    return this.flagRepo.findOpenByWorkspace(
      this.projectId,
      workspaceId,
      limit,
    );
  }

  async findByMemoryIds(memoryIds: string[]): Promise<Flag[]> {
    return this.flagRepo.findByMemoryIds(memoryIds);
  }

  async getFlagsByMemoryId(memoryId: string): Promise<Flag[]> {
    return this.flagRepo.findByMemoryId(memoryId);
  }

  async autoResolveByMemoryId(memoryId: string): Promise<number> {
    return this.flagRepo.autoResolveByMemoryId(memoryId);
  }

  async hasOpenFlag(
    memoryId: string,
    flagType: FlagType,
    relatedMemoryId?: string,
  ): Promise<boolean> {
    return this.flagRepo.hasOpenFlag(memoryId, flagType, relatedMemoryId);
  }
}
