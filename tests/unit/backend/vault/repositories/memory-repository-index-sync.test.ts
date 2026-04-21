import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultMemoryRepository } from "../../../../../src/backend/vault/repositories/memory-repository.js";
import { VaultWorkspaceRepository } from "../../../../../src/backend/vault/repositories/workspace-repository.js";
import { VaultVectorIndex } from "../../../../../src/backend/vault/vector/lance-index.js";
import type { Memory } from "../../../../../src/types/memory.js";

const DIMS = 3;
const now = new Date("2026-04-22T00:00:00.000Z");

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    project_id: "p1",
    workspace_id: "ws1",
    content: "body",
    title: "Title",
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
    ...overrides,
  };
}

describe("VaultMemoryRepository — lance index sync", () => {
  let root: string;
  let idx: VaultVectorIndex;
  let repo: VaultMemoryRepository;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repo-sync-"));
    idx = await VaultVectorIndex.create({ root, dims: DIMS });
    repo = await VaultMemoryRepository.create({ root, index: idx });
    await new VaultWorkspaceRepository({ root }).findOrCreate("ws1");
  });

  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("archive flips the lance row's archived flag", async () => {
    await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
    expect(await idx.countRows()).toBe(1);
    await repo.archive(["m1"]);
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits).toEqual([]);
  });

  it("update with new embedding replaces the vector", async () => {
    await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
    await repo.update("m1", 1, { content: "new", embedding: [0, 1, 0] });
    const hits = await idx.search({
      embedding: [0, 1, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0.9,
    });
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
  });

  it("update with no embedding preserves existing vector + updates meta", async () => {
    await repo.create({
      ...makeMemory({ title: "Old" }),
      embedding: [1, 0, 0],
    });
    await repo.update("m1", 1, { title: "New" });
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 1,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("m1");
  });
});
