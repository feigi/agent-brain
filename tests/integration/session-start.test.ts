import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  createTestService,
  createTestServiceWith,
  StubBackend,
  getTestDb,
  truncateAll,
  closeDb,
  assertMemory,
} from "../helpers.js";
import type { MemoryService } from "../../src/services/memory-service.js";
import type { StorageBackend } from "../../src/backend/types.js";
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

  it("sets meta.project_truncated when project memory count exceeds project_limit", async () => {
    for (let i = 1; i <= 4; i++) {
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

  it("does not set project_truncated when project count equals project_limit exactly", async () => {
    for (let i = 1; i <= 3; i++) {
      await service.create({
        content: `Global instruction at cap ${i}`,
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

    expect(result.meta.project_truncated).toBeUndefined();
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

  it("sets project_scope_status=failed when listProjectScoped throws; ranked results still returned", async () => {
    await service.create({
      workspace_id: "test-project",
      content:
        "Ranked workspace memory that must survive project-scope failure",
      type: "fact",
      author: "alice",
    });

    const spy = vi
      .spyOn(
        (service as unknown as { memoryRepo: { listProjectScoped: unknown } })
          .memoryRepo as { listProjectScoped: () => Promise<unknown> },
        "listProjectScoped",
      )
      .mockRejectedValue(new Error("simulated DB failure"));

    const result = await service.sessionStart("test-project", "alice");

    expect(result.data.length).toBe(1);
    expect(result.data[0].scope).toBe("workspace");
    expect(result.meta.project_scope_status).toBe("failed");
    expect(result.meta.project_truncated).toBeUndefined();

    spy.mockRestore();
  });

  it("ranked bucket excludes project-scoped memories even when they are newest", async () => {
    // Workspace memories created first (older).
    for (let i = 1; i <= 2; i++) {
      await service.create({
        workspace_id: "test-project",
        content: `Older workspace memory ${i}`,
        type: "fact",
        author: "alice",
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    // Project memories created last (newest) — must not displace workspace
    // memories in the ranked pool when listRecentWorkspaceAndUser is called.
    for (let i = 1; i <= 2; i++) {
      await service.create({
        content: `Newer project memory ${i}`,
        type: "decision",
        scope: "project",
        author: "alice",
      });
      await new Promise((r) => setTimeout(r, 5));
    }

    const result = await service.sessionStart(
      "test-project",
      "alice",
      undefined,
      2,
    );

    // With the narrowing: ranked bucket holds workspace-scoped only; project
    // memories come from the always-included path on top.
    const rankedWorkspace = result.data.filter((m) => m.scope === "workspace");
    const project = result.data.filter((m) => m.scope === "project");
    expect(rankedWorkspace.length).toBe(2);
    expect(project.length).toBe(2);
    expect(result.data.length).toBe(4);
  });

  it("DB rejects direct insert with scope=project and non-null workspace_id", async () => {
    let caught: unknown;
    try {
      await getTestDb()
        .insert(memories)
        .values({
          id: "m-violates-project-check",
          project_id: "test-project",
          workspace_id: "some-workspace",
          content: "This insert must be rejected by the CHECK constraint",
          title: "violating row",
          type: "decision",
          scope: "project",
          tags: [],
          author: "alice",
          source: "manual",
          metadata: {},
          embedding: new Array(config.embeddingDimensions).fill(0),
          version: 1,
        });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    // Postgres CHECK violation code is 23514; constraint name is in the
    // underlying driver error (drizzle wraps it — inspect the cause chain).
    const chain: unknown[] = [];
    let cur: unknown = caught;
    while (cur && chain.length < 5) {
      chain.push(cur);
      cur = (cur as { cause?: unknown }).cause;
    }
    const combined = chain
      .map((e) => {
        const anyE = e as {
          code?: string;
          constraint?: string;
          message?: string;
        };
        return `${anyE.code ?? ""}|${anyE.constraint ?? ""}|${anyE.message ?? ""}`;
      })
      .join(" || ");
    expect(combined).toMatch(/23514|memories_project_scope_null_workspace/i);
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

  it("envelope meta includes backend fields when backend.sessionStart returns non-empty", async () => {
    const stubBackend = new StubBackend();
    stubBackend.sessionStartMeta = {
      offline: true,
      unpushed_commits: 2,
      parse_errors: ["workspaces/ws1/memories/broken.md"],
    };
    const svc = createTestServiceWith({
      backend: stubBackend as unknown as StorageBackend,
    });

    const result = await svc.sessionStart("test-project", "alice");

    expect(result.meta.offline).toBe(true);
    expect(result.meta.unpushed_commits).toBe(2);
    expect(result.meta.parse_errors).toBe(1);
    expect(result.meta.pull_conflict).toBeUndefined();
  });

  it("envelope meta is unchanged when backend.sessionStart returns empty (pg-style)", async () => {
    const stubBackend = new StubBackend();
    stubBackend.sessionStartMeta = {}; // pg returns {}
    const svc = createTestServiceWith({
      backend: stubBackend as unknown as StorageBackend,
    });

    const result = await svc.sessionStart("test-project", "alice");

    expect(result.meta.offline).toBeUndefined();
    expect(result.meta.pull_conflict).toBeUndefined();
    expect(result.meta.unpushed_commits).toBeUndefined();
    expect(result.meta.parse_errors).toBeUndefined();
  });

  it("zero-value unpushed_commits and parse_errors are not merged into meta", async () => {
    const stubBackend = new StubBackend();
    stubBackend.sessionStartMeta = { unpushed_commits: 0 };
    const svc = createTestServiceWith({
      backend: stubBackend as unknown as StorageBackend,
    });

    const result = await svc.sessionStart("test-project", "alice");

    expect(result.meta.unpushed_commits).toBeUndefined();
    expect(result.meta.parse_errors).toBeUndefined();
  });
});
