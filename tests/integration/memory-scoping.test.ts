import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createTestService,
  truncateAll,
  closeDb,
  assertMemory,
} from "../helpers.js";
import type { MemoryService } from "../../src/services/memory-service.js";

describe("Memory scoping integration tests", () => {
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    service = createTestService();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("workspace-scoped memory not visible in other workspace (SCOP-01, SCOP-04)", async () => {
    // Create memory in project-a
    await service.create({
      project_id: "project-a",
      content: "Secret project-a knowledge about deployment pipelines",
      type: "fact",
      scope: "workspace",
      author: "alice",
    });

    // Search in project-b should NOT find it
    const result = await service.search(
      "deployment pipelines",
      "project-b",
      "workspace",
      "alice",
    );

    const crossProjectMatch = result.data.find(
      (m) => m.project_id === "project-a",
    );
    expect(crossProjectMatch).toBeUndefined();
  });

  it("user-scoped memory visible across projects (SCOP-02)", async () => {
    // Create user-scoped memory in project-a
    await service.create({
      project_id: "project-a",
      content: "User alice prefers vim keybindings everywhere",
      type: "preference",
      scope: "user",
      author: "alice",
    });

    // Search with user scope from project-b should find it
    const result = await service.search(
      "vim keybindings",
      "project-b",
      "user",
      "alice",
      undefined,
      -1, // negative threshold ensures mock embeddings with any cosine similarity pass through
    );

    expect(result.data.length).toBeGreaterThan(0);
    const found = result.data.find(
      (m) => m.author === "alice" && m.scope === "user",
    );
    expect(found).toBeDefined();
  });

  it("auto-creates project on first mention (D-34)", async () => {
    // Creating a memory with a brand-new project_id should succeed
    // without prior project creation
    const result = await service.create({
      project_id: "brand-new-project",
      content: "First memory in a new project",
      type: "fact",
      author: "alice",
    });
    assertMemory(result.data);

    expect(result.data.project_id).toBe("brand-new-project");
    expect(result.data.id).toBeDefined();
  });

  it("stale memories appear in list_stale", async () => {
    // Create a memory (verified_at is null by default = stale)
    const { data: createdData } = await service.create({
      project_id: "test-project",
      content: "Stale memory that has never been verified",
      type: "fact",
      author: "alice",
    });
    assertMemory(createdData);

    const staleResult = await service.listStale("test-project", "alice", 30);

    expect(staleResult.data.length).toBeGreaterThan(0);
    const found = staleResult.data.find((m) => m.id === createdData.id);
    expect(found).toBeDefined();
  });

  it("recently verified memories excluded from list_stale", async () => {
    const { data: createdData } = await service.create({
      project_id: "test-project",
      content: "Freshly verified memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(createdData);

    // Verify the memory (sets verified_at to now)
    await service.verify(createdData.id, "alice");

    const staleResult = await service.listStale("test-project", "alice", 30);

    const found = staleResult.data.find((m) => m.id === createdData.id);
    expect(found).toBeUndefined();
  });
});
