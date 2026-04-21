import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import seedrandom from "seedrandom";
import { DrizzleMemoryRepository } from "../../src/repositories/memory-repository.js";
import { DrizzleWorkspaceRepository } from "../../src/repositories/workspace-repository.js";
import { VaultMemoryRepository } from "../../src/backend/vault/repositories/memory-repository.js";
import { VaultWorkspaceRepository } from "../../src/backend/vault/repositories/workspace-repository.js";
import { VaultVectorIndex } from "../../src/backend/vault/vector/lance-index.js";
import { getTestDb, truncateAll } from "../helpers.js";
import type { Memory } from "../../src/types/memory.js";

const DIMS = 768;
const N = 500;

function randomUnitVec(rng: () => number): number[] {
  const v: number[] = [];
  let norm = 0;
  for (let i = 0; i < DIMS; i++) {
    const x = rng() - 0.5;
    v.push(x);
    norm += x * x;
  }
  const s = 1 / Math.sqrt(norm);
  return v.map((x) => x * s);
}

describe("vector parity — pg vs vault", () => {
  let root: string;
  let idx: VaultVectorIndex;
  let vault: VaultMemoryRepository;
  let pg: DrizzleMemoryRepository;

  beforeAll(async () => {
    const db = getTestDb();
    await truncateAll();
    root = await mkdtemp(join(tmpdir(), "parity-"));
    idx = await VaultVectorIndex.create({ root, dims: DIMS });
    vault = await VaultMemoryRepository.create({ root, index: idx });
    pg = new DrizzleMemoryRepository(db);
    await new DrizzleWorkspaceRepository(db).findOrCreate("ws1");
    await new VaultWorkspaceRepository({ root }).findOrCreate("ws1");

    const rng = seedrandom("parity-seed");
    const now = new Date();
    for (let i = 0; i < N; i++) {
      const m: Memory = {
        id: `m${i}`,
        project_id: "p1",
        workspace_id: "ws1",
        content: `body ${i}`,
        title: `T${i}`,
        type: "fact",
        scope: "workspace",
        tags: null,
        author: "a",
        source: null,
        session_id: null,
        metadata: null,
        embedding_model: null,
        embedding_dimensions: DIMS,
        version: 1,
        created_at: now,
        updated_at: now,
        verified_at: null,
        archived_at: null,
        comment_count: 0,
        flag_count: 0,
        relationship_count: 0,
        last_comment_at: null,
        verified_by: null,
      };
      const v = randomUnitVec(rng);
      await pg.create({ ...m, embedding: v });
      await vault.create({ ...m, embedding: v });
    }
  }, 120_000);

  afterAll(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("top-10 overlap ≥ 95% across 20 queries", async () => {
    const rng = seedrandom("parity-query");
    let totalOverlap = 0;
    const QUERIES = 20;
    const K = 10;
    for (let q = 0; q < QUERIES; q++) {
      const v = randomUnitVec(rng);
      const pgIds = (
        await pg.search({
          embedding: v,
          project_id: "p1",
          workspace_id: "ws1",
          scope: ["workspace"],
          limit: K,
          min_similarity: 0,
        })
      ).map((h) => h.id);
      const vaultIds = (
        await vault.search({
          embedding: v,
          project_id: "p1",
          workspace_id: "ws1",
          scope: ["workspace"],
          limit: K,
          min_similarity: 0,
        })
      ).map((h) => h.id);
      const overlap = pgIds.filter((id) => vaultIds.includes(id)).length;
      totalOverlap += overlap;
    }
    const overlapRatio = totalOverlap / (QUERIES * K);
    expect(overlapRatio).toBeGreaterThanOrEqual(0.95);
  }, 30_000);
});
