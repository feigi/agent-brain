import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { VectorQuery } from "@lancedb/lancedb";
import { ValidationError } from "../../../utils/errors.js";
import { memorySchema } from "./schema.js";

export interface IndexRow {
  id: string;
  project_id: string;
  workspace_id: string | null;
  scope: "workspace" | "user" | "project";
  author: string;
  title: string;
  archived: boolean;
  content_hash: string;
  vector: number[];
}

export interface VaultVectorIndexConfig {
  root: string;
  dims: number;
}

export class VaultVectorIndex {
  private constructor(
    private readonly db: lancedb.Connection,
    private readonly table: lancedb.Table,
    readonly dims: number,
  ) {}

  static async create(cfg: VaultVectorIndexConfig): Promise<VaultVectorIndex> {
    const dir = join(cfg.root, ".agent-brain", "index.lance");
    await mkdir(dir, { recursive: true });
    const db = await lancedb.connect(dir);
    const existing = await db.tableNames();
    const table = existing.includes("memories")
      ? await db.openTable("memories")
      : await db.createEmptyTable("memories", memorySchema(cfg.dims));
    return new VaultVectorIndex(db, table, cfg.dims);
  }

  async close(): Promise<void> {
    // @lancedb/lancedb manages connection lifetime internally; no
    // explicit close hook is required today. Kept for forward-compat
    // with future resource ownership changes.
  }

  async countRows(): Promise<number> {
    return await this.table.countRows();
  }

  async upsert(rows: IndexRow[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) this.#assertDim(r.vector, r.id);
    await this.table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows as unknown as Record<string, unknown>[]);
  }

  async search(params: SearchParams): Promise<SearchHit[]> {
    this.#assertDim(params.embedding);
    const clauses: string[] = [
      `archived = false`,
      `project_id = ${sqlStr(params.projectId)}`,
    ];
    const scopeClauses: string[] = [];
    for (const s of params.scope) {
      if (s === "workspace") {
        if (params.workspaceId === null) continue;
        scopeClauses.push(
          `(scope = 'workspace' AND workspace_id = ${sqlStr(params.workspaceId)})`,
        );
      } else if (s === "user") {
        if (params.userId === null) continue;
        scopeClauses.push(
          `(scope = 'user' AND author = ${sqlStr(params.userId)})`,
        );
      } else {
        scopeClauses.push(`scope = 'project'`);
      }
    }
    if (scopeClauses.length === 0) return [];
    clauses.push(`(${scopeClauses.join(" OR ")})`);
    const rows = (await (this.table.search(params.embedding) as VectorQuery)
      .distanceType("cosine")
      .where(clauses.join(" AND "))
      .limit(params.limit)
      .toArray()) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        id: r.id as string,
        relevance: 1 - Number(r._distance),
      }))
      .filter((h) => h.relevance >= params.minSimilarity);
  }

  async findDuplicates(params: DuplicateParams): Promise<DuplicateHit[]> {
    this.#assertDim(params.embedding);
    const clauses: string[] = [
      `archived = false`,
      `project_id = ${sqlStr(params.projectId)}`,
    ];
    if (params.scope === "workspace") {
      if (params.workspaceId === null) {
        throw new Error("workspaceId is required for workspace-scoped dedup");
      }
      clauses.push(
        `scope = 'workspace'`,
        `workspace_id = ${sqlStr(params.workspaceId)}`,
      );
    } else if (params.scope === "project") {
      clauses.push(`scope = 'project'`);
    } else {
      if (params.workspaceId === null) {
        throw new Error("workspaceId is required for user-scoped dedup");
      }
      clauses.push(
        `(workspace_id = ${sqlStr(params.workspaceId)}` +
          ` OR (scope = 'user' AND author = ${sqlStr(params.userId)}))`,
      );
    }
    const rows = (await (this.table.search(params.embedding) as VectorQuery)
      .distanceType("cosine")
      .where(clauses.join(" AND "))
      .limit(1)
      .toArray()) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        id: r.id as string,
        title: r.title as string,
        relevance: 1 - Number(r._distance),
        scope: r.scope as "workspace" | "user" | "project",
      }))
      .filter((h) => h.relevance >= params.threshold);
  }

  async findPairwiseSimilar(params: PairwiseParams): Promise<PairwiseHit[]> {
    const clauses: string[] = [
      `archived = false`,
      `project_id = ${sqlStr(params.projectId)}`,
    ];
    if (params.scope === "project") {
      clauses.push(`scope = 'project'`);
    } else {
      if (params.workspaceId === null) {
        throw new Error(
          "workspaceId is required for workspace-scoped pairwise",
        );
      }
      clauses.push(
        `scope = 'workspace'`,
        `workspace_id = ${sqlStr(params.workspaceId)}`,
      );
    }
    const where = clauses.join(" AND ");
    const rows = (await this.table
      .query()
      .where(where)
      .select(["id", "vector"])
      .toArray()) as Array<{ id: string; vector: number[] | Float32Array }>;
    const pairs: PairwiseHit[] = [];
    for (const r of rows) {
      const vec = Array.from(r.vector as ArrayLike<number>);
      const hits = (await (this.table.search(vec) as VectorQuery)
        .distanceType("cosine")
        .where(`${where} AND id > ${sqlStr(r.id)}`)
        .limit(32)
        .toArray()) as Array<Record<string, unknown>>;
      for (const h of hits) {
        const sim = 1 - Number(h._distance);
        if (sim >= params.threshold) {
          pairs.push({
            memory_a_id: r.id,
            memory_b_id: h.id as string,
            similarity: sim,
          });
        }
      }
    }
    pairs.sort((a, b) => b.similarity - a.similarity);
    return pairs;
  }

  // Returns rowsUpdated so callers can detect index drift (id missing).
  // lancedb's update() on zero matches succeeds silently — caller must
  // treat rowsUpdated === 0 as a warning condition, not as success.
  async markArchived(id: string): Promise<number> {
    const res = await this.table.update({
      where: `id = ${sqlStr(id)}`,
      values: { archived: true },
    });
    return res.rowsUpdated;
  }

  async getContentHash(id: string): Promise<string | null> {
    const rows = (await this.table
      .query()
      .where(`id = ${sqlStr(id)}`)
      .select(["content_hash"])
      .limit(1)
      .toArray()) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    return String(rows[0].content_hash);
  }

  /** Phase 6 / migration use only. Fetches the embedding vector for an id. */
  async lookup(id: string): Promise<{ embedding: number[] } | null> {
    const rows = (await this.table
      .query()
      .where(`id = ${sqlStr(id)}`)
      .select(["vector"])
      .limit(1)
      .toArray()) as Array<{ vector: number[] | Float32Array }>;
    if (rows.length === 0) return null;
    return { embedding: Array.from(rows[0].vector as ArrayLike<number>) };
  }

  async upsertMetaOnly(
    meta: Omit<IndexRow, "content_hash" | "vector">,
  ): Promise<number> {
    const res = await this.table.update({
      where: `id = ${sqlStr(meta.id)}`,
      values: {
        project_id: meta.project_id,
        scope: meta.scope,
        author: meta.author,
        title: meta.title,
        archived: meta.archived,
        workspace_id: meta.workspace_id,
      },
    });
    return res.rowsUpdated;
  }

  async listEmbeddings(
    params: ListEmbeddingsParams,
  ): Promise<Array<{ id: string; vector: number[] }>> {
    const clauses: string[] = [
      `archived = false`,
      `project_id = ${sqlStr(params.projectId)}`,
    ];
    if (params.scope === "workspace") {
      if (params.workspaceId === null) {
        throw new Error("workspaceId is required for workspace listEmbeddings");
      }
      clauses.push(
        `scope = 'workspace'`,
        `workspace_id = ${sqlStr(params.workspaceId)}`,
      );
    } else if (params.scope === "user") {
      clauses.push(`scope = 'user'`);
      if (params.userId !== null) {
        clauses.push(`author = ${sqlStr(params.userId)}`);
      }
      if (params.workspaceId !== null) {
        clauses.push(`workspace_id = ${sqlStr(params.workspaceId)}`);
      }
    } else {
      clauses.push(`scope = 'project'`);
    }
    const rows = (await this.table
      .query()
      .where(clauses.join(" AND "))
      .select(["id", "vector"])
      .limit(params.limit)
      .toArray()) as Array<{ id: string; vector: number[] | Float32Array }>;
    return rows.map((r) => ({
      id: r.id,
      vector: Array.from(r.vector as ArrayLike<number>),
    }));
  }

  #assertDim(vec: number[], id?: string): void {
    if (vec.length === this.dims) return;
    const suffix = id === undefined ? "" : ` for id ${id}`;
    throw new ValidationError(
      `vector dimension mismatch: expected ${this.dims}, got ${vec.length}${suffix}`,
    );
  }
}

export interface ListEmbeddingsParams {
  projectId: string;
  workspaceId: string | null;
  scope: "workspace" | "user" | "project";
  userId: string | null;
  limit: number;
}

export interface PairwiseParams {
  projectId: string;
  workspaceId: string | null;
  scope: "workspace" | "project";
  threshold: number;
}

export interface PairwiseHit {
  memory_a_id: string;
  memory_b_id: string;
  similarity: number;
}

export interface DuplicateParams {
  embedding: number[];
  projectId: string;
  workspaceId: string | null;
  scope: "workspace" | "user" | "project";
  userId: string;
  threshold: number;
}

export interface DuplicateHit {
  id: string;
  title: string;
  relevance: number;
  scope: "workspace" | "user" | "project";
}

export interface SearchParams {
  embedding: number[];
  projectId: string;
  workspaceId: string | null;
  scope: Array<"workspace" | "user" | "project">;
  userId: string | null;
  limit: number;
  minSimilarity: number;
}

export interface SearchHit {
  id: string;
  relevance: number;
}

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
