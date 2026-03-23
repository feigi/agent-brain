import {
  eq, and, isNull, gt, lt, sql, desc, asc, inArray, arrayOverlaps, or,
  cosineDistance,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { memories } from "../db/schema.js";
import type { Memory, MemoryWithRelevance } from "../types/memory.js";
import { ConflictError } from "../utils/errors.js";
import type { MemoryRepository, ListOptions, SearchOptions, StaleOptions } from "./types.js";

// D-44: Explicit column selection -- never return embedding vector
const memoryColumns = {
  id: memories.id,
  project_id: memories.project_id,
  content: memories.content,
  title: memories.title,
  type: memories.type,
  scope: memories.scope,
  tags: memories.tags,
  author: memories.author,
  source: memories.source,
  session_id: memories.session_id,
  metadata: memories.metadata,
  embedding_model: memories.embedding_model,
  embedding_dimensions: memories.embedding_dimensions,
  version: memories.version,
  created_at: memories.created_at,
  updated_at: memories.updated_at,
  verified_at: memories.verified_at,
  archived_at: memories.archived_at,
} as const;

function rowToMemory(row: typeof memoryColumns extends Record<string, infer _> ? Record<string, unknown> : never): Memory {
  return row as unknown as Memory;
}

export class DrizzleMemoryRepository implements MemoryRepository {
  constructor(private readonly db: Database) {}

  async create(memory: Memory & { embedding: number[] }): Promise<Memory> {
    const result = await this.db
      .insert(memories)
      .values({
        id: memory.id,
        project_id: memory.project_id,
        content: memory.content,
        title: memory.title,
        type: memory.type,
        scope: memory.scope,
        tags: memory.tags,
        author: memory.author,
        source: memory.source,
        session_id: memory.session_id,
        metadata: memory.metadata,
        embedding: memory.embedding,
        embedding_model: memory.embedding_model,
        embedding_dimensions: memory.embedding_dimensions,
        version: memory.version,
      })
      .returning(memoryColumns);

    return rowToMemory(result[0]);
  }

  async findById(id: string): Promise<Memory | null> {
    const result = await this.db
      .select(memoryColumns)
      .from(memories)
      .where(and(eq(memories.id, id), isNull(memories.archived_at)))
      .limit(1);

    return result.length > 0 ? rowToMemory(result[0]) : null;
  }

  // D-30: Optimistic locking via version check
  async update(
    id: string,
    expectedVersion: number,
    updates: Partial<Memory> & { embedding?: number[] | null },
  ): Promise<Memory> {
    const setValues: Record<string, unknown> = {
      updated_at: sql`now()`,
      version: sql`${memories.version} + 1`,
    };

    if (updates.content !== undefined) setValues.content = updates.content;
    if (updates.title !== undefined) setValues.title = updates.title;
    if (updates.type !== undefined) setValues.type = updates.type;
    if (updates.tags !== undefined) setValues.tags = updates.tags;
    if (updates.metadata !== undefined) setValues.metadata = updates.metadata;

    // Re-embedding: update embedding + model + dimensions
    if (updates.embedding !== undefined) {
      setValues.embedding = updates.embedding;
      setValues.embedding_model = updates.embedding_model ?? null;
      setValues.embedding_dimensions = updates.embedding_dimensions ?? null;
    }

    const result = await this.db
      .update(memories)
      .set(setValues)
      .where(
        and(
          eq(memories.id, id),
          eq(memories.version, expectedVersion),
          isNull(memories.archived_at),
        )
      )
      .returning(memoryColumns);

    if (result.length === 0) {
      throw new ConflictError(
        `Memory ${id} update failed: version mismatch (expected ${expectedVersion}) or memory not found/archived`
      );
    }

    return rowToMemory(result[0]);
  }

  // D-28: Archive nulls out embedding vector
  // D-67: Archiving already-archived memories is idempotent
  async archive(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const result = await this.db
      .update(memories)
      .set({
        archived_at: sql`now()`,
        embedding: null,
        updated_at: sql`now()`,
      })
      .where(
        and(
          inArray(memories.id, ids),
          isNull(memories.archived_at),
        )
      )
      .returning({ id: memories.id });

    return result.length;
  }

  // RESEARCH Pattern 5: Cosine similarity search
  async search(options: SearchOptions): Promise<MemoryWithRelevance[]> {
    const limit = options.limit ?? 10;          // D-41
    const minSimilarity = options.min_similarity ?? 0.3; // D-42

    const distance = cosineDistance(memories.embedding, options.embedding);
    const similarity = sql<number>`1 - (${distance})`;

    const conditions: SQL[] = [isNull(memories.archived_at)];

    // SCOP-01: project scope queries project_id
    // SCOP-02: user scope queries author + scope column
    // SCOP-03: cross-scope ('both') uses OR for project + user memories
    if (options.scope === "project") {
      conditions.push(eq(memories.project_id, options.project_id));
    } else if (options.scope === "user") {
      if (!options.user_id) {
        throw new Error("user_id is required for user-scoped search");
      }
      conditions.push(eq(memories.author, options.user_id));
      conditions.push(eq(memories.scope, "user"));
    } else {
      // scope === 'both' (D-10: single SQL query with OR)
      if (!options.user_id) {
        throw new Error("user_id is required for cross-scope search (D-09)");
      }
      conditions.push(
        or(
          eq(memories.project_id, options.project_id),
          and(eq(memories.author, options.user_id), eq(memories.scope, "user")),
        )!,
      );
    }

    const result = await this.db
      .select({
        ...memoryColumns,
        similarity,
      })
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(similarity))
      .limit(limit);

    // D-42: Filter by min_similarity in application layer
    // (pgvector cosineDistance doesn't support direct threshold in WHERE easily)
    return result
      .filter((row) => Number(row.similarity) >= minSimilarity)
      .map((row) => {
        // Strip the SQL-computed 'similarity' alias before spreading to avoid leaking
        // internal column names into the MemoryWithRelevance output
        const { similarity: rawSim, ...memoryFields } = row;
        return {
          ...rowToMemory(memoryFields as typeof row),
          relevance: Number(rawSim),
        };
      });
  }

  // RESEARCH Pattern 6: Cursor-based pagination
  async list(options: ListOptions): Promise<{
    memories: Memory[];
    has_more: boolean;
    cursor?: { created_at: string; id: string };
  }> {
    const limit = options.limit ?? 20;
    const sortBy = options.sort_by ?? "created_at";
    const order = options.order ?? "desc";

    const conditions: SQL[] = [isNull(memories.archived_at)];

    // SCOP-01, SCOP-04: Scope-based filtering
    if (options.scope === "project") {
      conditions.push(eq(memories.project_id, options.project_id));
    } else {
      if (!options.user_id) {
        throw new Error("user_id is required for user-scoped list");
      }
      conditions.push(eq(memories.author, options.user_id));
      conditions.push(eq(memories.scope, "user"));
    }

    // D-48: Optional type filter
    if (options.type) {
      conditions.push(eq(memories.type, options.type as typeof memories.type.enumValues[number]));
    }

    // D-48: Optional tags filter (array overlap)
    if (options.tags && options.tags.length > 0) {
      conditions.push(arrayOverlaps(memories.tags, options.tags));
    }

    // Cursor-based pagination: fetch items after the cursor position
    if (options.cursor) {
      const cursorDate = new Date(options.cursor.created_at);
      const sortColumn = sortBy === "updated_at" ? memories.updated_at : memories.created_at;

      if (order === "desc") {
        // For descending: get items before the cursor (older)
        conditions.push(
          or(
            lt(sortColumn, cursorDate),
            and(eq(sortColumn, cursorDate), lt(memories.id, options.cursor.id)),
          )!,
        );
      } else {
        // For ascending: get items after the cursor (newer)
        conditions.push(
          or(
            gt(sortColumn, cursorDate),
            and(eq(sortColumn, cursorDate), gt(memories.id, options.cursor.id)),
          )!,
        );
      }
    }

    const sortColumn = sortBy === "updated_at" ? memories.updated_at : memories.created_at;
    const orderFn = order === "desc" ? desc : asc;

    // D-46: Fetch limit+1 to determine has_more
    const result = await this.db
      .select(memoryColumns)
      .from(memories)
      .where(and(...conditions))
      .orderBy(orderFn(sortColumn), orderFn(memories.id))
      .limit(limit + 1);

    const hasMore = result.length > limit;
    const rows = hasMore ? result.slice(0, limit) : result;
    const memoryRows = rows.map(rowToMemory);

    const lastRow = memoryRows[memoryRows.length - 1];
    const cursor = lastRow
      ? {
          created_at: (sortBy === "updated_at" ? lastRow.updated_at : lastRow.created_at).toISOString(),
          id: lastRow.id,
        }
      : undefined;

    return {
      memories: memoryRows,
      has_more: hasMore,
      cursor: hasMore ? cursor : undefined,
    };
  }

  // D-12: Find stale memories (not verified recently)
  async findStale(options: StaleOptions): Promise<{
    memories: Memory[];
    has_more: boolean;
    cursor?: { created_at: string; id: string };
  }> {
    const limit = options.limit ?? 20;
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - options.threshold_days);

    const conditions: SQL[] = [
      eq(memories.project_id, options.project_id),
      isNull(memories.archived_at),
      or(
        isNull(memories.verified_at),
        lt(memories.verified_at, thresholdDate),
      )!,
    ];

    // Cursor-based pagination
    if (options.cursor) {
      const cursorDate = new Date(options.cursor.created_at);
      conditions.push(
        or(
          lt(memories.created_at, cursorDate),
          and(eq(memories.created_at, cursorDate), lt(memories.id, options.cursor.id)),
        )!,
      );
    }

    const result = await this.db
      .select(memoryColumns)
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.created_at), desc(memories.id))
      .limit(limit + 1);

    const hasMore = result.length > limit;
    const rows = hasMore ? result.slice(0, limit) : result;
    const memoryRows = rows.map(rowToMemory);

    const lastRow = memoryRows[memoryRows.length - 1];
    const cursor = lastRow
      ? { created_at: lastRow.created_at.toISOString(), id: lastRow.id }
      : undefined;

    return {
      memories: memoryRows,
      has_more: hasMore,
      cursor: hasMore ? cursor : undefined,
    };
  }

  async verify(id: string): Promise<Memory | null> {
    const result = await this.db
      .update(memories)
      .set({
        verified_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(
        and(eq(memories.id, id), isNull(memories.archived_at))
      )
      .returning(memoryColumns);

    return result.length > 0 ? rowToMemory(result[0]) : null;
  }
}
