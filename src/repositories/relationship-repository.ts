import { eq, and, or, isNull, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { relationships } from "../db/schema.js";
import type { Relationship } from "../types/relationship.js";
import type { RelationshipRepository } from "./types.js";

export class DrizzleRelationshipRepository implements RelationshipRepository {
  constructor(private readonly db: Database) {}

  async create(relationship: Relationship): Promise<Relationship> {
    const [row] = await this.db
      .insert(relationships)
      .values({
        id: relationship.id,
        project_id: relationship.project_id,
        source_id: relationship.source_id,
        target_id: relationship.target_id,
        type: relationship.type,
        description: relationship.description,
        confidence: relationship.confidence,
        created_by: relationship.created_by,
        created_via: relationship.created_via,
        archived_at: relationship.archived_at,
        created_at: relationship.created_at,
      })
      .returning();
    return row as Relationship;
  }

  async findById(id: string): Promise<Relationship | null> {
    const [row] = await this.db
      .select()
      .from(relationships)
      .where(and(eq(relationships.id, id), isNull(relationships.archived_at)));
    return (row as Relationship) ?? null;
  }

  async findByMemoryId(
    projectId: string,
    memoryId: string,
    direction: "outgoing" | "incoming" | "both",
    type?: string,
  ): Promise<Relationship[]> {
    const conditions = [
      eq(relationships.project_id, projectId),
      isNull(relationships.archived_at),
    ];

    if (direction === "outgoing") {
      conditions.push(eq(relationships.source_id, memoryId));
    } else if (direction === "incoming") {
      conditions.push(eq(relationships.target_id, memoryId));
    } else {
      conditions.push(
        or(
          eq(relationships.source_id, memoryId),
          eq(relationships.target_id, memoryId),
        )!,
      );
    }

    if (type) {
      conditions.push(eq(relationships.type, type));
    }

    const rows = await this.db
      .select()
      .from(relationships)
      .where(and(...conditions))
      .orderBy(relationships.created_at);

    return rows as Relationship[];
  }

  async findExisting(
    projectId: string,
    sourceId: string,
    targetId: string,
    type: string,
  ): Promise<Relationship | null> {
    const [row] = await this.db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.project_id, projectId),
          eq(relationships.source_id, sourceId),
          eq(relationships.target_id, targetId),
          eq(relationships.type, type),
          isNull(relationships.archived_at),
        ),
      );
    return (row as Relationship) ?? null;
  }

  async findBetweenMemories(
    projectId: string,
    memoryIds: string[],
  ): Promise<Relationship[]> {
    if (memoryIds.length < 2) return [];

    const rows = await this.db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.project_id, projectId),
          isNull(relationships.archived_at),
          inArray(relationships.source_id, memoryIds),
          inArray(relationships.target_id, memoryIds),
        ),
      )
      .orderBy(relationships.created_at);

    return rows as Relationship[];
  }

  async archiveByMemoryId(memoryId: string): Promise<number> {
    const result = await this.db
      .update(relationships)
      .set({ archived_at: sql`now()` })
      .where(
        and(
          or(
            eq(relationships.source_id, memoryId),
            eq(relationships.target_id, memoryId),
          ),
          isNull(relationships.archived_at),
        ),
      )
      .returning({ id: relationships.id });
    return result.length;
  }

  async archiveById(id: string): Promise<boolean> {
    const result = await this.db
      .update(relationships)
      .set({ archived_at: sql`now()` })
      .where(and(eq(relationships.id, id), isNull(relationships.archived_at)))
      .returning({ id: relationships.id });
    return result.length > 0;
  }
}
