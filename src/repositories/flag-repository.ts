import { eq, and, isNull, desc, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { flags, memories } from "../db/schema.js";
import type { Flag, FlagResolution } from "../types/flag.js";
import type { FlagRepository } from "./types.js";

export class DrizzleFlagRepository implements FlagRepository {
  constructor(private readonly db: Database) {}

  async create(flag: Flag): Promise<Flag> {
    const result = await this.db
      .insert(flags)
      .values({
        id: flag.id,
        project_id: flag.project_id,
        memory_id: flag.memory_id,
        flag_type: flag.flag_type,
        severity: flag.severity,
        details: flag.details,
        resolved_at: flag.resolved_at,
        resolved_by: flag.resolved_by,
      })
      .returning();
    return result[0] as Flag;
  }

  async findOpenByWorkspace(
    projectId: string,
    workspaceId: string,
    limit: number,
  ): Promise<Flag[]> {
    // Find unresolved needs_review flags for memories in this workspace or project scope
    const result = await this.db
      .select({
        id: flags.id,
        project_id: flags.project_id,
        memory_id: flags.memory_id,
        flag_type: flags.flag_type,
        severity: flags.severity,
        details: flags.details,
        resolved_at: flags.resolved_at,
        resolved_by: flags.resolved_by,
        created_at: flags.created_at,
      })
      .from(flags)
      .innerJoin(memories, eq(flags.memory_id, memories.id))
      .where(
        and(
          eq(flags.project_id, projectId),
          eq(flags.severity, "needs_review"),
          isNull(flags.resolved_at),
          sql`(${memories.workspace_id} = ${workspaceId} OR ${memories.scope} = 'project')`,
        ),
      )
      .orderBy(flags.created_at)
      .limit(limit);
    return result as Flag[];
  }

  async resolve(
    id: string,
    resolvedBy: string,
    resolution: FlagResolution,
  ): Promise<Flag | null> {
    // For "deferred", push to back of queue by updating created_at
    if (resolution === "deferred") {
      const result = await this.db
        .update(flags)
        .set({ created_at: sql`now()` })
        .where(and(eq(flags.id, id), isNull(flags.resolved_at)))
        .returning();
      return result.length > 0 ? (result[0] as Flag) : null;
    }

    const result = await this.db
      .update(flags)
      .set({
        resolved_at: sql`now()`,
        resolved_by: resolvedBy,
      })
      .where(and(eq(flags.id, id), isNull(flags.resolved_at)))
      .returning();
    return result.length > 0 ? (result[0] as Flag) : null;
  }

  async findByMemoryId(memoryId: string): Promise<Flag[]> {
    return (await this.db
      .select()
      .from(flags)
      .where(eq(flags.memory_id, memoryId))
      .orderBy(desc(flags.created_at))) as Flag[];
  }

  async autoResolveByMemoryId(memoryId: string): Promise<number> {
    const result = await this.db
      .update(flags)
      .set({
        resolved_at: sql`now()`,
        resolved_by: "system",
      })
      .where(and(eq(flags.memory_id, memoryId), isNull(flags.resolved_at)))
      .returning({ id: flags.id });
    return result.length;
  }
}
