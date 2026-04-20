import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createTestService,
  createTestServiceWithAudit,
  truncateAll,
  closeDb,
  assertMemory,
  getTestDb,
} from "../helpers.js";
import type { MemoryService } from "../../src/services/memory-service.js";
import { memories } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { DrizzleAuditRepository } from "../../src/repositories/audit-repository.js";
import { AuditService } from "../../src/services/audit-service.js";

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
      ["workspace"],
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
      ["user"],
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
    // Create a memory and backdate created_at to 31 days ago to simulate staleness
    const { data: createdData } = await service.create({
      workspace_id: "test-project",
      content: "Stale memory that has never been verified",
      type: "fact",
      author: "alice",
    });
    assertMemory(createdData);

    const thirtyOneDaysAgo = new Date();
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);
    await getTestDb()
      .update(memories)
      .set({ created_at: thirtyOneDaysAgo })
      .where(eq(memories.id, createdData.id));

    const staleResult = await service.listStale("test-project", "alice", 30);

    expect(staleResult.data.length).toBeGreaterThan(0);
    const found = staleResult.data.find((m) => m.id === createdData.id);
    expect(found).toBeDefined();
  });

  it("project-scoped memory visible across all workspaces", async () => {
    // Create a project-scoped memory (cross-workspace)
    const result = await service.create({
      content: "Always use ESM imports in this project - universal standard",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(result.data);

    // Search from a different workspace with project scope requested
    // returns the cross-workspace memory.
    const searchResult = await service.search(
      "ESM imports",
      "workspace-b",
      ["workspace", "project"],
      "bob",
      undefined,
      -1,
    );

    const found = searchResult.data.find((m) => m.scope === "project");
    expect(found).toBeDefined();
    expect(found!.content).toContain("ESM imports");
  });

  it("search without project scope excludes project-scoped memories", async () => {
    await service.create({
      content: "Project-scoped only memory that must stay out",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });

    const searchResult = await service.search(
      "project scoped only",
      "workspace-b",
      ["workspace"],
      "bob",
      undefined,
      -1,
    );

    expect(
      searchResult.data.find((m) => m.scope === "project"),
    ).toBeUndefined();
  });

  it("project-scoped memory cannot be created by agent-auto", async () => {
    const result = await service.create({
      content: "Agent trying to create project-scoped memory",
      type: "fact",
      scope: "project",
      author: "agent-user",
      source: "agent-auto",
    });
    expect("skipped" in result.data).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("requires_project_scope_confirmation");
    }
  });

  it("project-scoped memory cannot be created by session-review", async () => {
    const result = await service.create({
      content: "Session review trying to create project-scoped memory",
      type: "fact",
      scope: "project",
      author: "agent-user",
      source: "session-review",
    });
    expect("skipped" in result.data).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("requires_project_scope_confirmation");
    }
  });

  it("project-scoped memory can be created manually", async () => {
    const result = await service.create({
      content: "Manual project-scoped memory about coding standards",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(result.data);
    expect(result.data.scope).toBe("project");
  });

  it("project-scoped memory coerces workspace_id to null", async () => {
    const result = await service.create({
      workspace_id: "workspace-a",
      content: "caller inconsistently supplied workspace_id for project scope",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(result.data);
    expect(result.data.scope).toBe("project");
    expect(result.data.workspace_id).toBeNull();
  });

  it("search scope array returns only explicitly requested scopes", async () => {
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
      content: "Project-wide convention for error handling patterns",
      type: "pattern",
      scope: "project",
      author: "alice",
      source: "manual",
    });

    // Requesting only workspace + user scopes returns those scopes literally;
    // project-scoped memories are excluded unless explicitly requested.
    const result = await service.search(
      "configuration patterns",
      "test-project",
      ["workspace", "user"],
      "alice",
      undefined,
      -1,
    );

    const scopes = result.data.map((m) => m.scope);
    expect(scopes).toContain("workspace");
    expect(scopes).toContain("user");
    expect(scopes).not.toContain("project");

    // With project scope explicitly requested, it is returned
    const resultWithProject = await service.search(
      "configuration patterns",
      "test-project",
      ["workspace", "user", "project"],
      "alice",
      undefined,
      -1,
    );
    const scopesWithProject = resultWithProject.data.map((m) => m.scope);
    expect(scopesWithProject).toContain("project");
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

  it("lists memories across multiple scopes", async () => {
    const ws = await service.create({
      workspace_id: "test-project",
      content: "Workspace memory for multi-scope test",
      type: "fact",
      author: "alice",
    });
    assertMemory(ws.data);

    const user = await service.create({
      workspace_id: "test-project",
      content: "User memory for multi-scope test",
      type: "fact",
      author: "alice",
      scope: "user",
    });
    assertMemory(user.data);

    const result = await service.list({
      project_id: "test-project",
      workspace_id: "test-project",
      scope: ["workspace", "user"],
      user_id: "alice",
    });

    expect(result.data.length).toBe(2);
    const scopes = result.data.map((m) => m.scope);
    expect(scopes).toContain("workspace");
    expect(scopes).toContain("user");
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

  describe("project-scope confirmation retry flow (#21)", () => {
    let serviceWithAudit: MemoryService;
    let auditRepo: DrizzleAuditRepository;

    beforeEach(() => {
      const db = getTestDb();
      auditRepo = new DrizzleAuditRepository(db);
      const auditService = new AuditService(auditRepo, "test-project");
      serviceWithAudit = createTestServiceWithAudit(auditService);
    });

    it("autonomous skip → user confirms → retry succeeds → audit records reason", async () => {
      const skipResult = await serviceWithAudit.create({
        content: "Cross-workspace coding convention: prefer async/await",
        type: "pattern",
        scope: "project",
        author: "alice",
        source: "session-review",
      });

      expect("skipped" in skipResult.data).toBe(true);
      if ("skipped" in skipResult.data) {
        expect(skipResult.data.reason).toBe(
          "requires_project_scope_confirmation",
        );
      }

      // Retry after user confirms
      const okResult = await serviceWithAudit.create({
        content: "Cross-workspace coding convention: prefer async/await",
        type: "pattern",
        scope: "project",
        author: "alice",
        source: "session-review",
        user_confirmed_project_scope: true,
      });

      expect("skipped" in okResult.data).toBe(false);
      if (!("skipped" in okResult.data)) {
        expect(okResult.data.scope).toBe("project");
        expect(okResult.data.workspace_id).toBeNull();

        const entries = await auditRepo.findByMemoryId(okResult.data.id);
        const created = entries.find((e) => e.action === "created");
        expect(created?.reason).toBe("user-confirmed project scope");
      }
    });
  });
});
