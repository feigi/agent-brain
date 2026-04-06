import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createTestService,
  truncateAll,
  closeDb,
  assertMemory,
} from "../helpers.js";
import { ValidationError } from "../../src/utils/errors.js";
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
      workspace_id: "project-a",
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

    // Workspace isolation: searching in project-b should not return project-a's memories
    const crossWorkspaceMatch = result.data.find(
      (m) =>
        m.content === "Secret project-a knowledge about deployment pipelines",
    );
    expect(crossWorkspaceMatch).toBeUndefined();
  });

  it("user-scoped memory visible across projects (SCOP-02)", async () => {
    // Create user-scoped memory in project-a
    await service.create({
      workspace_id: "project-a",
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
      workspace_id: "brand-new-project",
      content: "First memory in a new project",
      type: "fact",
      author: "alice",
    });
    assertMemory(result.data);

    expect(result.data.project_id).toBe("test-project");
    expect(result.data.id).toBeDefined();
  });

  it("stale memories appear in list_stale", async () => {
    // Create a memory (verified_at is null by default = stale)
    const { data: createdData } = await service.create({
      workspace_id: "test-project",
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

  it("project-scoped memory visible across all workspaces", async () => {
    // Create a project-scoped memory (cross-workspace)
    const result = await service.create({
      workspace_id: "workspace-a",
      content: "Always use ESM imports in this project - universal standard",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(result.data);

    // Search from a different workspace should find it
    const searchResult = await service.search(
      "ESM imports",
      "workspace-b",
      "workspace",
      "bob",
      undefined,
      -1,
    );

    const found = searchResult.data.find((m) => m.scope === "project");
    expect(found).toBeDefined();
    expect(found!.content).toContain("ESM imports");
  });

  it("project-scoped memory cannot be created by agent-auto", async () => {
    await expect(
      service.create({
        workspace_id: "test-project",
        content: "Agent trying to create project-scoped memory",
        type: "fact",
        scope: "project",
        author: "agent-user",
        source: "agent-auto",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("project-scoped memory cannot be created by session-review", async () => {
    await expect(
      service.create({
        workspace_id: "test-project",
        content: "Session review trying to create project-scoped memory",
        type: "fact",
        scope: "project",
        author: "agent-user",
        source: "session-review",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("project-scoped memory can be created manually", async () => {
    const result = await service.create({
      workspace_id: "test-project",
      content: "Manual project-scoped memory about coding standards",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(result.data);
    expect(result.data.scope).toBe("project");
  });

  it("search scope=both includes project-scoped memories", async () => {
    // Create workspace-scoped memory
    await service.create({
      workspace_id: "test-project",
      content: "Workspace-specific deployment configuration",
      type: "fact",
      scope: "workspace",
      author: "alice",
    });
    // Create user-scoped memory
    await service.create({
      workspace_id: "test-project",
      content: "User preference for dark mode terminals",
      type: "preference",
      scope: "user",
      author: "alice",
    });
    // Create project-scoped memory
    await service.create({
      workspace_id: "test-project",
      content: "Project-wide convention for error handling patterns",
      type: "pattern",
      scope: "project",
      author: "alice",
      source: "manual",
    });

    const result = await service.search(
      "configuration patterns",
      "test-project",
      "both",
      "alice",
      undefined,
      -1,
    );

    const scopes = result.data.map((m) => m.scope);
    expect(scopes).toContain("workspace");
    expect(scopes).toContain("user");
    expect(scopes).toContain("project");
  });

  it("default scope is workspace when not specified", async () => {
    const result = await service.create({
      workspace_id: "test-project",
      content: "Memory with default scope",
      type: "fact",
      author: "alice",
    });
    assertMemory(result.data);
    expect(result.data.scope).toBe("workspace");
  });

  it("recently verified memories excluded from list_stale", async () => {
    const { data: createdData } = await service.create({
      workspace_id: "test-project",
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
