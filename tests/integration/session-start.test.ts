import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createTestService,
  getTestDb,
  truncateAll,
  closeDb,
  assertMemory,
} from "../helpers.js";
import type { MemoryService } from "../../src/services/memory-service.js";
import { ValidationError } from "../../src/utils/errors.js";
import { memories } from "../../src/db/schema.js";
import { config } from "../../src/config.js";

describe("memory_session_start integration tests", () => {
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    service = createTestService();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns relevant memories with context (RETR-04)", async () => {
    // Create project and user memories
    await service.create({
      workspace_id: "test-project",
      content: "Database migration patterns for PostgreSQL schema evolution",
      type: "fact",
      scope: "workspace",
      author: "alice",
    });
    await service.create({
      workspace_id: "test-project",
      content:
        "Alice prefers explicit migration files over auto-generated ones",
      type: "preference",
      scope: "user",
      author: "alice",
    });

    const result = await service.sessionStart(
      "test-project",
      "alice",
      "database migration",
    );

    expect(result.data.length).toBeGreaterThan(0);
    // Results should have relevance, not similarity
    for (const memory of result.data) {
      expect(memory).toHaveProperty("relevance");
      expect(memory.relevance).toBeGreaterThanOrEqual(0);
      expect(memory.relevance).toBeLessThanOrEqual(1);
    }
    // Should include both scopes (D-15)
    const scopes = result.data.map((m) => m.scope);
    expect(scopes).toContain("workspace");
    expect(scopes).toContain("user");
  });

  it("returns recent memories without context (RETR-04)", async () => {
    // Create memories
    await service.create({
      workspace_id: "test-project",
      content: "First memory created for recency test",
      type: "fact",
      scope: "workspace",
      author: "alice",
    });
    await service.create({
      workspace_id: "test-project",
      content: "Second memory created more recently",
      type: "fact",
      scope: "workspace",
      author: "alice",
    });

    const result = await service.sessionStart("test-project", "alice");

    expect(result.data.length).toBe(2);
    // Should have relevance scores
    for (const memory of result.data) {
      expect(memory).toHaveProperty("relevance");
      expect(memory.relevance).toBeGreaterThan(0);
    }
  });

  it("respects limit parameter (RETR-05)", async () => {
    // Create 5 memories
    for (let i = 1; i <= 5; i++) {
      await service.create({
        workspace_id: "test-project",
        content: `Session start test memory number ${i}`,
        type: "fact",
        author: "alice",
      });
    }

    const result = await service.sessionStart(
      "test-project",
      "alice",
      undefined,
      2,
    );

    expect(result.data.length).toBe(2);
  });

  it("default limit is 10 (RETR-05, D-16)", async () => {
    // Create 15 memories
    for (let i = 1; i <= 15; i++) {
      await service.create({
        workspace_id: "test-project",
        content: `Bulk memory for default limit test ${i}`,
        type: "fact",
        author: "alice",
      });
    }

    const result = await service.sessionStart("test-project", "alice");

    expect(result.data.length).toBe(10);
  });

  it("returns empty array when no memories exist", async () => {
    const result = await service.sessionStart(
      "test-project",
      "alice",
      "anything",
    );

    expect(result.data).toEqual([]);
    expect(result.meta.count).toBe(0);
  });

  it("includes user-scoped memories from any project (D-15)", async () => {
    // Create user memory in a different project
    await service.create({
      workspace_id: "other-project",
      content: "User-wide preference that should appear in session start",
      type: "preference",
      scope: "user",
      author: "alice",
    });

    const result = await service.sessionStart("test-project", "alice");

    expect(result.data.length).toBe(1);
    expect(result.data[0].scope).toBe("user");
  });

  it("excludes archived memories", async () => {
    const { data: createdData } = await service.create({
      workspace_id: "test-project",
      content: "This will be archived and should not appear at session start",
      type: "fact",
      author: "alice",
    });
    assertMemory(createdData);
    await service.archive(createdData.id, "alice");

    const result = await service.sessionStart("test-project", "alice");

    const found = result.data.find((m) => m.id === createdData.id);
    expect(found).toBeUndefined();
  });

  it("always includes project-scoped memories beyond ranked limit", async () => {
    // Two project-scoped "global instructions"
    await service.create({
      content: "Global instruction: never commit secrets",
      type: "decision",
      scope: "project",
      author: "alice",
    });
    await service.create({
      content: "Global instruction: always run migrations before deploy",
      type: "decision",
      scope: "project",
      author: "alice",
    });

    // Fill workspace with more memories than the ranked limit
    for (let i = 1; i <= 5; i++) {
      await service.create({
        workspace_id: "test-project",
        content: `Workspace memory number ${i}`,
        type: "fact",
        author: "alice",
      });
    }

    // limit=2 on ranked portion; project memories must still be present
    const result = await service.sessionStart(
      "test-project",
      "alice",
      undefined,
      2,
    );

    const projectScoped = result.data.filter((m) => m.scope === "project");
    expect(projectScoped.length).toBe(2);
    // Total = 2 workspace (ranked) + 2 project (always included)
    expect(result.data.length).toBe(4);
    // No duplicate IDs
    const ids = result.data.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("project_limit caps project-scoped memories", async () => {
    for (let i = 1; i <= 5; i++) {
      await service.create({
        content: `Global instruction number ${i}`,
        type: "decision",
        scope: "project",
        author: "alice",
      });
    }

    const result = await service.sessionStart(
      "test-project",
      "alice",
      undefined,
      10,
      3,
    );

    const projectScoped = result.data.filter((m) => m.scope === "project");
    expect(projectScoped.length).toBe(3);
  });

  it("context search fills ranked limit with workspace/user only, project memories added on top", async () => {
    // 5 workspace memories — ranked pool should not be displaced by project
    for (let i = 1; i <= 5; i++) {
      await service.create({
        workspace_id: "test-project",
        content: `Workspace memory about databases number ${i}`,
        type: "fact",
        author: "alice",
      });
    }
    // 2 project-scoped memories
    await service.create({
      content: "Global instruction about databases one",
      type: "decision",
      scope: "project",
      author: "alice",
    });
    await service.create({
      content: "Global instruction about databases two",
      type: "decision",
      scope: "project",
      author: "alice",
    });

    const result = await service.sessionStart(
      "test-project",
      "alice",
      "databases",
      3,
    );

    const workspaceScoped = result.data.filter((m) => m.scope === "workspace");
    const projectScoped = result.data.filter((m) => m.scope === "project");
    // Ranked limit=3 fully populated by workspace memories (not displaced)
    expect(workspaceScoped.length).toBe(3);
    // Both project memories added on top of ranked results
    expect(projectScoped.length).toBe(2);
    expect(result.data.length).toBe(5);
  });

  it("includes project-scoped memories with context search", async () => {
    await service.create({
      content: "Global instruction: always use parameterized queries",
      type: "decision",
      scope: "project",
      author: "alice",
    });
    await service.create({
      workspace_id: "test-project",
      content: "PostgreSQL parameterized query patterns for security",
      type: "fact",
      scope: "workspace",
      author: "alice",
    });

    const result = await service.sessionStart(
      "test-project",
      "alice",
      "database security",
    );

    const projectScoped = result.data.filter((m) => m.scope === "project");
    expect(projectScoped.length).toBe(1);
    // Workspace memory also present from semantic search
    expect(result.data.length).toBeGreaterThanOrEqual(2);
    // No duplicates
    const ids = result.data.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no duplicate memories in response", async () => {
    // Create project + workspace memories
    await service.create({
      content: "Global instruction for dedup test",
      type: "decision",
      scope: "project",
      author: "alice",
    });
    await service.create({
      workspace_id: "test-project",
      content: "Workspace memory for dedup test",
      type: "fact",
      author: "alice",
    });

    const result = await service.sessionStart("test-project", "alice");

    const ids = result.data.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("excludes archived project-scoped memories", async () => {
    const { data: created } = await service.create({
      content: "Archived global instruction",
      type: "decision",
      scope: "project",
      author: "alice",
    });
    assertMemory(created);
    await service.archive(created.id, "alice");

    const result = await service.sessionStart("test-project", "alice");

    expect(result.data.find((m) => m.id === created.id)).toBeUndefined();
  });

  it("behaves identically when no project-scoped memories exist", async () => {
    await service.create({
      workspace_id: "test-project",
      content: "Workspace-only memory",
      type: "fact",
      author: "alice",
    });

    const result = await service.sessionStart("test-project", "alice");

    expect(result.data.length).toBe(1);
    expect(result.data[0].scope).toBe("workspace");
    expect(result.meta.project_truncated).toBeUndefined();
  });

  it("project memories ordered by recency when project_limit truncates", async () => {
    const created: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const { data } = await service.create({
        content: `Project memory ${i}`,
        type: "decision",
        scope: "project",
        author: "alice",
      });
      assertMemory(data);
      created.push(data.id);
      // Ensure deterministic creation order for the recency assertion
      await new Promise((r) => setTimeout(r, 5));
    }

    const result = await service.sessionStart(
      "test-project",
      "alice",
      undefined,
      10,
      2,
    );

    const projectIds = result.data
      .filter((m) => m.scope === "project")
      .map((m) => m.id);
    expect(projectIds).toHaveLength(2);
    // Newest two (last two created) must be the ones returned
    expect(new Set(projectIds)).toEqual(new Set(created.slice(-2)));
  });

  it("sets meta.project_truncated when project memory count hits project_limit", async () => {
    for (let i = 1; i <= 3; i++) {
      await service.create({
        content: `Global instruction ${i}`,
        type: "decision",
        scope: "project",
        author: "alice",
      });
    }

    const result = await service.sessionStart(
      "test-project",
      "alice",
      undefined,
      10,
      3,
    );

    expect(result.meta.project_truncated).toBe(true);
  });

  it("does not set project_truncated when under project_limit", async () => {
    await service.create({
      content: "Single project memory",
      type: "decision",
      scope: "project",
      author: "alice",
    });

    const result = await service.sessionStart(
      "test-project",
      "alice",
      undefined,
      10,
      5,
    );

    expect(result.meta.project_truncated).toBeUndefined();
  });

  it("rejects invalid project_limit at service entry", async () => {
    await expect(
      service.sessionStart("test-project", "alice", undefined, 10, 0),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.sessionStart("test-project", "alice", undefined, 10, 201),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.sessionStart("test-project", "alice", undefined, 10, 1.5),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.sessionStart("test-project", "alice", undefined, 10, Number.NaN),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("listProjectScoped isolates memories by project_id", async () => {
    // Create one project memory under test-project via the standard service
    // fixture (project_id="test-project").
    await service.create({
      content: "Test-project global instruction",
      type: "decision",
      scope: "project",
      author: "alice",
    });
    // Direct-insert a project memory under a different project_id. This
    // regression-guards that listProjectScoped filters on project_id.
    await getTestDb()
      .insert(memories)
      .values({
        id: "m-other-project-test",
        project_id: "other-project",
        workspace_id: null,
        content: "Other-project global instruction",
        title: "Other-project global instruction",
        type: "decision",
        scope: "project",
        tags: [],
        author: "alice",
        source: "manual",
        metadata: {},
        embedding: new Array(config.embeddingDimensions).fill(0),
        version: 1,
      });

    const result = await service.sessionStart("test-project", "alice");

    const projectRows = result.data.filter((m) => m.scope === "project");
    expect(projectRows).toHaveLength(1);
    expect(projectRows[0].content).toContain("Test-project");
  });

  it("response envelope has count and timing (D-18)", async () => {
    await service.create({
      workspace_id: "test-project",
      content: "Envelope test memory",
      type: "fact",
      author: "alice",
    });

    const result = await service.sessionStart("test-project", "alice");

    expect(result.meta).toHaveProperty("count");
    expect(result.meta).toHaveProperty("timing");
    expect(result.meta.count).toBe(1);
    expect(result.meta.timing).toBeTypeOf("number");
  });
});
