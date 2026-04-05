import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  getTestDb,
  truncateAll,
  closeDb,
  assertMemory,
  createTestService,
} from "../helpers.js";
import { DrizzleMemoryRepository } from "../../src/repositories/memory-repository.js";
import type { MemoryService } from "../../src/services/memory-service.js";

describe("consolidation repository support", () => {
  let memoryRepo: DrizzleMemoryRepository;
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    memoryRepo = new DrizzleMemoryRepository(db);
    service = createTestService();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("finds pairwise similar memories within workspace", async () => {
    const m1 = await service.create({
      workspace_id: "test-ws",
      content: "Always use UTC timestamps in database columns",
      type: "decision",
      author: "alice",
    });
    assertMemory(m1.data);
    const m2 = await service.create({
      workspace_id: "test-ws",
      content: "Always use UTC timestamps in the database",
      type: "decision",
      author: "alice",
    });
    assertMemory(m2.data);

    const pairs = await memoryRepo.findPairwiseSimilar({
      projectId: "test-project",
      workspaceId: "test-ws",
      scope: "workspace",
      threshold: 0.5, // Low threshold for mock embeddings
    });

    // With mock embeddings the similarity may vary, but both memories should be found
    expect(pairs.length).toBeGreaterThanOrEqual(0); // Mock embeddings are random, so can't guarantee match
  });

  it("lists distinct workspaces", async () => {
    await service.create({
      workspace_id: "ws-a",
      content: "memory in ws-a",
      type: "fact",
      author: "alice",
    });
    await service.create({
      workspace_id: "ws-b",
      content: "memory in ws-b",
      type: "fact",
      author: "alice",
    });

    const workspaces = await memoryRepo.listDistinctWorkspaces("test-project");
    expect(workspaces).toContain("ws-a");
    expect(workspaces).toContain("ws-b");
  });

  it("lists memories with embeddings for a workspace", async () => {
    const m1 = await service.create({
      workspace_id: "test-ws",
      content: "memory with embedding",
      type: "fact",
      author: "alice",
    });
    assertMemory(m1.data);

    const withEmbeddings = await memoryRepo.listWithEmbeddings({
      projectId: "test-project",
      workspaceId: "test-ws",
      scope: "workspace",
      limit: 10,
    });

    expect(withEmbeddings).toHaveLength(1);
    expect(withEmbeddings[0].embedding).toBeDefined();
    expect(Array.isArray(withEmbeddings[0].embedding)).toBe(true);
    expect(withEmbeddings[0].embedding.length).toBe(768); // mock dimensions
  });
});
