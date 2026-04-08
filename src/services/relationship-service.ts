import type {
  RelationshipRepository,
  MemoryRepository,
} from "../repositories/types.js";
import type {
  Relationship,
  RelationshipWithMemory,
} from "../types/relationship.js";
import type { Memory } from "../types/memory.js";
import { generateId } from "../utils/id.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface CreateRelationshipInput {
  sourceId: string;
  targetId: string;
  type: string;
  description?: string;
  /** Value between 0 and 1 inclusive */
  confidence?: number;
  userId: string;
  createdVia?: string;
}

export class RelationshipService {
  constructor(
    private readonly relationshipRepo: RelationshipRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly projectId: string,
  ) {}

  private canAccess(memory: Memory, userId: string): boolean {
    if (memory.scope === "workspace" || memory.scope === "project") return true;
    return memory.author === userId;
  }

  private validateConfidence(confidence: number): void {
    if (confidence < 0 || confidence > 1) {
      throw new ValidationError(
        `Confidence must be between 0 and 1, got ${confidence}`,
      );
    }
  }

  private buildRelationship(input: CreateRelationshipInput): Relationship {
    return {
      id: generateId(),
      project_id: this.projectId,
      source_id: input.sourceId,
      target_id: input.targetId,
      type: input.type,
      description: input.description ?? null,
      confidence: input.confidence ?? 1.0,
      created_by: input.userId,
      created_via: input.createdVia ?? null,
      archived_at: null,
      created_at: new Date(),
    };
  }

  async create(input: CreateRelationshipInput): Promise<Relationship> {
    if (input.sourceId === input.targetId) {
      throw new ValidationError("Source and target must be different memories");
    }

    if (input.confidence !== undefined) {
      this.validateConfidence(input.confidence);
    }

    const source = await this.memoryRepo.findById(input.sourceId);
    if (
      !source ||
      source.project_id !== this.projectId ||
      !this.canAccess(source, input.userId)
    ) {
      throw new NotFoundError("Memory", input.sourceId);
    }

    const target = await this.memoryRepo.findById(input.targetId);
    if (
      !target ||
      target.project_id !== this.projectId ||
      !this.canAccess(target, input.userId)
    ) {
      throw new NotFoundError("Memory", input.targetId);
    }

    const existing = await this.relationshipRepo.findExisting(
      this.projectId,
      input.sourceId,
      input.targetId,
      input.type,
    );
    if (existing) return existing;

    const relationship = this.buildRelationship(input);
    const created = await this.relationshipRepo.create(relationship);
    logger.debug(
      `Created relationship ${created.id} (${input.type}) between ${input.sourceId} → ${input.targetId}`,
    );
    return created;
  }

  /**
   * Create a relationship without per-user access control.
   *
   * Used by system actors (consolidation engine, migration scripts) that operate
   * across all memories regardless of scope. The consolidation engine is reachable
   * via the `memory_consolidate` MCP tool, which already operates without per-user
   * access control — this method extends that existing privilege model to
   * relationship creation.
   *
   * Still validates: both memories exist, belong to this project, self-ref check, dedup.
   */
  async createInternal(input: CreateRelationshipInput): Promise<Relationship> {
    if (input.sourceId === input.targetId) {
      throw new ValidationError("Source and target must be different memories");
    }

    if (input.confidence !== undefined) {
      this.validateConfidence(input.confidence);
    }

    const source = await this.memoryRepo.findById(input.sourceId);
    if (!source || source.project_id !== this.projectId) {
      throw new NotFoundError("Memory", input.sourceId);
    }

    const target = await this.memoryRepo.findById(input.targetId);
    if (!target || target.project_id !== this.projectId) {
      throw new NotFoundError("Memory", input.targetId);
    }

    const existing = await this.relationshipRepo.findExisting(
      this.projectId,
      input.sourceId,
      input.targetId,
      input.type,
    );
    if (existing) return existing;

    const relationship = this.buildRelationship(input);
    const created = await this.relationshipRepo.create(relationship);
    logger.debug(
      `Created internal relationship ${created.id} (${input.type}) between ${input.sourceId} → ${input.targetId}`,
    );
    return created;
  }

  async remove(id: string, userId: string): Promise<void> {
    const relationship = await this.relationshipRepo.findById(id);
    if (!relationship) {
      throw new NotFoundError("Relationship", id);
    }

    const source = await this.memoryRepo.findById(relationship.source_id);
    const target = await this.memoryRepo.findById(relationship.target_id);

    const canEditSource = source && this.canAccess(source, userId);
    const canEditEitherSide =
      relationship.created_via === "consolidation" &&
      (canEditSource || (target && this.canAccess(target, userId)));

    if (!canEditSource && !canEditEitherSide) {
      throw new NotFoundError("Relationship", id);
    }

    await this.relationshipRepo.archiveById(id);
    logger.debug(`Archived relationship ${id}`);
  }

  async listForMemory(
    memoryId: string,
    direction: "outgoing" | "incoming" | "both",
    userId: string,
    type?: string,
  ): Promise<RelationshipWithMemory[]> {
    const relationships = await this.relationshipRepo.findByMemoryId(
      this.projectId,
      memoryId,
      direction,
      type,
    );

    const relatedIds = new Set<string>();
    for (const rel of relationships) {
      const relatedId =
        rel.source_id === memoryId ? rel.target_id : rel.source_id;
      relatedIds.add(relatedId);
    }
    const relatedMemories = await this.memoryRepo.findByIds([...relatedIds]);
    const memoryMap = new Map(relatedMemories.map((m) => [m.id, m]));

    const result: RelationshipWithMemory[] = [];
    for (const rel of relationships) {
      const isOutgoing = rel.source_id === memoryId;
      const relatedId = isOutgoing ? rel.target_id : rel.source_id;
      const related = memoryMap.get(relatedId);
      if (!related || !this.canAccess(related, userId)) continue;

      result.push({
        id: rel.id,
        source_id: rel.source_id,
        target_id: rel.target_id,
        type: rel.type,
        description: rel.description,
        confidence: rel.confidence,
        created_by: rel.created_by,
        created_via: rel.created_via,
        direction: isOutgoing ? "outgoing" : "incoming",
        related_memory: {
          id: related.id,
          title: related.title,
          type: related.type,
          scope: related.scope,
        },
        created_at: rel.created_at,
      });
    }
    return result;
  }

  async listBetweenMemories(
    memoryIds: string[],
    userId: string,
  ): Promise<RelationshipWithMemory[]> {
    const relationships = await this.relationshipRepo.findBetweenMemories(
      this.projectId,
      memoryIds,
    );

    const relatedIds = new Set<string>();
    for (const rel of relationships) {
      relatedIds.add(rel.source_id);
      relatedIds.add(rel.target_id);
    }
    const relatedMemories = await this.memoryRepo.findByIds([...relatedIds]);
    const memoryMap = new Map(relatedMemories.map((m) => [m.id, m]));

    const result: RelationshipWithMemory[] = [];
    for (const rel of relationships) {
      const source = memoryMap.get(rel.source_id);
      const target = memoryMap.get(rel.target_id);
      // Skip if either side is inaccessible
      if (!source || !this.canAccess(source, userId)) continue;
      if (!target || !this.canAccess(target, userId)) continue;

      // Direction is always "outgoing" — we're showing the graph edge between
      // session memories, not a per-memory perspective.
      result.push({
        id: rel.id,
        source_id: rel.source_id,
        target_id: rel.target_id,
        type: rel.type,
        description: rel.description,
        confidence: rel.confidence,
        created_by: rel.created_by,
        created_via: rel.created_via,
        direction: "outgoing",
        related_memory: {
          id: target.id,
          title: target.title,
          type: target.type,
          scope: target.scope,
        },
        created_at: rel.created_at,
      });
    }
    return result;
  }

  async archiveByMemoryId(memoryId: string): Promise<number> {
    const count = await this.relationshipRepo.archiveByMemoryId(memoryId);
    if (count > 0) {
      logger.info(`Archived ${count} relationship(s) for memory ${memoryId}`);
    }
    return count;
  }
}
