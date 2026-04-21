import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
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
    for (const r of rows) {
      if (r.vector.length !== this.dims) {
        throw new Error(
          `vector dimension mismatch: expected ${this.dims}, got ${r.vector.length} for id ${r.id}`,
        );
      }
    }
    await this.table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
  }

  async search(params: SearchParams): Promise<SearchHit[]> {
    if (params.embedding.length !== this.dims) {
      throw new Error(
        `vector dimension mismatch: expected ${this.dims}, got ${params.embedding.length}`,
      );
    }
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
    const rows = (await this.table
      .search(params.embedding)
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
    if (params.embedding.length !== this.dims) {
      throw new Error(
        `vector dimension mismatch: expected ${this.dims}, got ${params.embedding.length}`,
      );
    }
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
    const rows = (await this.table
      .search(params.embedding)
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
