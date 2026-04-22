import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { VectorQuery } from "@lancedb/lancedb";

describe("@lancedb/lancedb smoke", () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("connects, creates a table, queries it", async () => {
    root = await mkdtemp(join(tmpdir(), "lance-smoke-"));
    const db = await lancedb.connect(root);
    const table = await db.createTable("t", [
      { id: "a", vector: [0.1, 0.2, 0.3] },
      { id: "b", vector: [0.9, 0.8, 0.7] },
    ]);
    const got = await (table.search([0.1, 0.2, 0.3]) as VectorQuery)
      .distanceType("cosine")
      .limit(2)
      .toArray();
    expect(got.map((r: Record<string, unknown>) => r.id)).toEqual(["a", "b"]);
  });
});
