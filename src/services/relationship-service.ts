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

export interface CreateRelationshipInput {
  sourceId: string;
  targetId: string;
  type: string;
  description?: string;
  confidence?: number;
  userId: string;
  source?: string;
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

  async create(input: CreateRelationshipInput): Promise<Relationship> {
    if (input.sourceId === input.targetId) {
      throw new ValidationError("Source and target must be different memories");
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

    const relationship: Relationship = {
      id: generateId(),
      project_id: this.projectId,
      source_id: input.sourceId,
      target_id: input.targetId,
      type: input.type,
      description: input.description ?? null,
      confidence: input.confidence ?? 1.0,
      created_by: input.userId,
      source: input.source ?? null,
      archived_at: null,
      created_at: new Date(),
    };

    return this.relationshipRepo.create(relationship);
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
      relationship.source === "consolidation" &&
      (canEditSource || (target && this.canAccess(target, userId)));

    if (!canEditSource && !canEditEitherSide) {
      throw new NotFoundError("Relationship", id);
    }

    await this.relationshipRepo.deleteById(id);
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

    const result: RelationshipWithMemory[] = [];
    for (const rel of relationships) {
      const isOutgoing = rel.source_id === memoryId;
      const relatedId = isOutgoing ? rel.target_id : rel.source_id;
      const related = await this.memoryRepo.findById(relatedId);
      if (!related || !this.canAccess(related, userId)) continue;

      result.push({
        id: rel.id,
        source_id: rel.source_id,
        target_id: rel.target_id,
        type: rel.type,
        description: rel.description,
        confidence: rel.confidence,
        created_by: rel.created_by,
        source: rel.source,
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

    const result: RelationshipWithMemory[] = [];
    for (const rel of relationships) {
      const source = await this.memoryRepo.findById(rel.source_id);
      const target = await this.memoryRepo.findById(rel.target_id);
      // Skip if either side is inaccessible
      if (!source || !this.canAccess(source, userId)) continue;
      if (!target || !this.canAccess(target, userId)) continue;

      result.push({
        id: rel.id,
        source_id: rel.source_id,
        target_id: rel.target_id,
        type: rel.type,
        description: rel.description,
        confidence: rel.confidence,
        created_by: rel.created_by,
        source: rel.source,
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
    return this.relationshipRepo.archiveByMemoryId(memoryId);
  }
}
