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
}
