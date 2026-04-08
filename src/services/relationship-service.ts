import type {
  RelationshipRepository,
  MemoryRepository,
} from "../repositories/types.js";
import type {
  Relationship,
  RelationshipWithMemory,
  CreateRelationshipInput,
} from "../types/relationship.js";
import type { Memory } from "../types/memory.js";
import { generateId } from "../utils/id.js";
import { canAccessMemory } from "../utils/access.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const SYSTEM_ACTOR = "consolidation";

export class RelationshipService {
  constructor(
    private readonly relationshipRepo: RelationshipRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly projectId: string,
  ) {}

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

  /**
   * Shared creation logic. When `internal` is true, skips per-user access control
   * and includes archived memories (for system actors like the consolidation engine).
   */
  private async createWithOptions(
    input: CreateRelationshipInput,
    internal: boolean,
  ): Promise<Relationship> {
    if (input.sourceId === input.targetId) {
      throw new ValidationError("Source and target must be different memories");
    }

    if (
      input.confidence !== undefined &&
      !(input.confidence >= 0 && input.confidence <= 1)
    ) {
      throw new ValidationError(
        `Confidence must be between 0 and 1, got ${input.confidence}`,
      );
    }

    const findFn = internal
      ? (id: string) => this.memoryRepo.findByIdIncludingArchived(id)
      : (id: string) => this.memoryRepo.findById(id);

    const [source, target] = await Promise.all([
      findFn(input.sourceId),
      findFn(input.targetId),
    ]);

    if (
      !source ||
      source.project_id !== this.projectId ||
      (!internal && !canAccessMemory(source, input.userId))
    ) {
      throw new NotFoundError("Memory", input.sourceId);
    }

    if (
      !target ||
      target.project_id !== this.projectId ||
      (!internal && !canAccessMemory(target, input.userId))
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

  async create(input: CreateRelationshipInput): Promise<Relationship> {
    return this.createWithOptions(input, false);
  }

  /**
   * Create a relationship without per-user access control.
   * Used by system actors (consolidation engine, migration scripts) that operate
   * across all memories regardless of scope.
   */
  async createInternal(input: CreateRelationshipInput): Promise<Relationship> {
    return this.createWithOptions(input, true);
  }

  async remove(id: string, userId: string): Promise<void> {
    const relationship = await this.relationshipRepo.findById(id);
    if (!relationship) {
      throw new NotFoundError("Relationship", id);
    }

    const [source, target] = await Promise.all([
      this.memoryRepo.findById(relationship.source_id),
      this.memoryRepo.findById(relationship.target_id),
    ]);

    const isCreator = relationship.created_by === userId;
    const canEditSource = source && canAccessMemory(source, userId);
    const canEditTarget = target && canAccessMemory(target, userId);
    const canEditEitherSide =
      relationship.created_via === SYSTEM_ACTOR &&
      (canEditSource || canEditTarget);
    const canRemove =
      canEditSource ||
      isCreator ||
      (!source && canEditTarget) ||
      canEditEitherSide;

    if (!canRemove) {
      throw new NotFoundError("Relationship", id);
    }

    await this.relationshipRepo.archiveById(id);
    logger.debug(`Archived relationship ${id}`);
  }

  private toRelationshipWithMemory(
    rel: Relationship,
    direction: "outgoing" | "incoming",
    related: Memory,
  ): RelationshipWithMemory {
    return {
      id: rel.id,
      source_id: rel.source_id,
      target_id: rel.target_id,
      type: rel.type,
      description: rel.description,
      confidence: rel.confidence,
      created_by: rel.created_by,
      created_via: rel.created_via,
      direction,
      related_memory: {
        id: related.id,
        title: related.title,
        type: related.type,
        scope: related.scope,
      },
      created_at: rel.created_at,
    };
  }

  async listForMemory(
    memoryId: string,
    direction: "outgoing" | "incoming" | "both",
    userId: string,
    type?: string,
  ): Promise<RelationshipWithMemory[]> {
    const anchorMemory = await this.memoryRepo.findById(memoryId);
    if (
      !anchorMemory ||
      anchorMemory.project_id !== this.projectId ||
      !canAccessMemory(anchorMemory, userId)
    ) {
      throw new NotFoundError("Memory", memoryId);
    }

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
      if (!related || !canAccessMemory(related, userId)) continue;

      result.push(
        this.toRelationshipWithMemory(
          rel,
          isOutgoing ? "outgoing" : "incoming",
          related,
        ),
      );
    }
    return result;
  }

  async listForMemories(
    memoryIds: string[],
    direction: "outgoing" | "incoming" | "both",
    userId: string,
    type?: string,
  ): Promise<RelationshipWithMemory[]> {
    if (memoryIds.length === 0) return [];

    // Verify access to all anchor memories
    const anchorMemories = await this.memoryRepo.findByIds(memoryIds);
    const accessibleAnchors = anchorMemories.filter(
      (m) => m.project_id === this.projectId && canAccessMemory(m, userId),
    );
    const anchorIds = new Set(accessibleAnchors.map((m) => m.id));
    if (anchorIds.size === 0) return [];

    const relationships = await this.relationshipRepo.findByMemoryIds(
      this.projectId,
      [...anchorIds],
      direction,
      type,
    );

    // Collect related memory IDs (the "other end" of each relationship)
    const relatedIds = new Set<string>();
    for (const rel of relationships) {
      if (anchorIds.has(rel.source_id)) relatedIds.add(rel.target_id);
      if (anchorIds.has(rel.target_id)) relatedIds.add(rel.source_id);
    }
    // Remove anchor IDs that are already fetched
    for (const id of anchorIds) relatedIds.delete(id);

    // Batch-fetch related memories
    const relatedMemories =
      relatedIds.size > 0
        ? await this.memoryRepo.findByIds([...relatedIds])
        : [];
    const memoryMap = new Map(
      [...accessibleAnchors, ...relatedMemories].map((m) => [m.id, m]),
    );

    const result: RelationshipWithMemory[] = [];
    for (const rel of relationships) {
      const isSourceAnchor = anchorIds.has(rel.source_id);
      const isTargetAnchor = anchorIds.has(rel.target_id);

      if (isSourceAnchor) {
        const related = memoryMap.get(rel.target_id);
        if (!related || !canAccessMemory(related, userId)) continue;
        result.push(this.toRelationshipWithMemory(rel, "outgoing", related));
      }
      if (isTargetAnchor && !isSourceAnchor) {
        const related = memoryMap.get(rel.source_id);
        if (!related || !canAccessMemory(related, userId)) continue;
        result.push(this.toRelationshipWithMemory(rel, "incoming", related));
      }
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
      if (!source || !canAccessMemory(source, userId)) continue;
      if (!target || !canAccessMemory(target, userId)) continue;

      result.push(this.toRelationshipWithMemory(rel, "outgoing", target));
    }
    return result;
  }

  async archiveByMemoryId(memoryId: string): Promise<number> {
    const count = await this.relationshipRepo.archiveByMemoryId(
      memoryId,
      this.projectId,
    );
    if (count > 0) {
      logger.info(`Archived ${count} relationship(s) for memory ${memoryId}`);
    }
    return count;
  }
}
