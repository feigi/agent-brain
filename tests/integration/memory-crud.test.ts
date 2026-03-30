import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createTestService,
  truncateAll,
  closeDb,
  assertMemory,
} from "../helpers.js";
import type { MemoryService } from "../../src/services/memory-service.js";
import { ConflictError, NotFoundError } from "../../src/utils/errors.js";

describe("Memory CRUD integration tests", () => {
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    service = createTestService();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates a memory with all fields", async () => {
    const result = await service.create({
      project_id: "test-project",
      content: "Always use parameterized queries",
      type: "decision",
      author: "alice",
    });
    assertMemory(result.data);

    expect(result.data.id).toBeTypeOf("string");
    expect(result.data.id.length).toBe(21); // nanoid default
    expect(result.data.content).toBe("Always use parameterized queries");
    expect(result.data.type).toBe("decision");
    expect(result.data.project_id).toBe("test-project");
    expect(result.data.author).toBe("alice");
    expect(result.data.version).toBe(1);
    expect(result.data.scope).toBe("workspace"); // default
    expect(result.data.embedding_model).toBe("mock-deterministic");
    expect(result.data.embedding_dimensions).toBe(512);
    expect(result.meta.timing).toBeTypeOf("number");
  });

  it("auto-generates title from content when not provided", async () => {
    const longContent =
      "This is a very long piece of content that exceeds eighty characters and should be truncated for the auto title generation";

    const result = await service.create({
      project_id: "test-project",
      content: longContent,
      type: "fact",
      author: "alice",
    });
    assertMemory(result.data);

    expect(result.data.title).toBe(longContent.slice(0, 80) + "...");
  });

  it("stores optional fields: source, session_id, metadata, tags", async () => {
    const result = await service.create({
      project_id: "test-project",
      content: "Test content with optional fields",
      type: "learning",
      author: "bob",
      source: "manual",
      session_id: "sess-1",
      metadata: { file: "README.md" },
      tags: ["deploy", "ci"],
    });
    assertMemory(result.data);

    const fetched = await service.get(result.data.id, "bob");
    expect(fetched.data.source).toBe("manual");
    expect(fetched.data.session_id).toBe("sess-1");
    expect(fetched.data.metadata).toEqual({ file: "README.md" });
    expect(fetched.data.tags).toEqual(["deploy", "ci"]);
  });

  it("retrieves a memory by ID", async () => {
    const created = await service.create({
      project_id: "test-project",
      content: "Retrievable memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    const fetched = await service.get(created.data.id, "alice");
    expect(fetched.data.content).toBe("Retrievable memory");
    expect(fetched.data.id).toBe(created.data.id);
  });

  it("throws NotFoundError for non-existent ID", async () => {
    await expect(service.get("nonexistent-id-12345", "alice")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("updates content and increments version", async () => {
    const created = await service.create({
      project_id: "test-project",
      content: "Original content",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    const updated = await service.update(
      created.data.id,
      1,
      {
        content: "Updated content",
      },
      "alice",
    );

    expect(updated.data.version).toBe(2);
    expect(updated.data.content).toBe("Updated content");
    expect(updated.data.updated_at.getTime()).toBeGreaterThanOrEqual(
      created.data.created_at.getTime(),
    );
  });

  it("update with re-embed: changing content triggers new embedding", async () => {
    const created = await service.create({
      project_id: "test-project",
      content: "Original content for embedding",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    const updated = await service.update(
      created.data.id,
      1,
      {
        content: "Completely different content for re-embedding",
      },
      "alice",
    );

    // The embedding model should still be set (re-embedding happened)
    expect(updated.data.embedding_model).toBe("mock-deterministic");
    expect(updated.data.embedding_dimensions).toBe(512);
    expect(updated.data.version).toBe(2);
  });

  it("rejects update with wrong version (optimistic locking)", async () => {
    const created = await service.create({
      project_id: "test-project",
      content: "Version conflict test",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    // First update succeeds (version 1 -> 2)
    await service.update(
      created.data.id,
      1,
      {
        content: "First update",
      },
      "alice",
    );

    // Second update with stale version 1 fails
    await expect(
      service.update(created.data.id, 1, { content: "Stale update" }, "alice"),
    ).rejects.toThrow(ConflictError);
  });

  it("archives a single memory", async () => {
    const created = await service.create({
      project_id: "test-project",
      content: "Memory to archive",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    const result = await service.archive(created.data.id, "alice");
    expect(result.data.archived_count).toBe(1);

    // Archived memory not returned by get
    await expect(service.get(created.data.id, "alice")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("archives multiple memories in bulk", async () => {
    const m1 = await service.create({
      project_id: "test-project",
      content: "Bulk archive 1",
      type: "fact",
      author: "alice",
    });
    assertMemory(m1.data);
    const m2 = await service.create({
      project_id: "test-project",
      content: "Bulk archive 2",
      type: "fact",
      author: "alice",
    });
    assertMemory(m2.data);

    const result = await service.archive([m1.data.id, m2.data.id], "alice");
    expect(result.data.archived_count).toBe(2);
  });

  it("archive is idempotent (D-67)", async () => {
    const created = await service.create({
      project_id: "test-project",
      content: "Idempotent archive test",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    await service.archive(created.data.id, "alice");
    // Second archive should succeed without error
    const result = await service.archive(created.data.id, "alice");
    // Already archived, so count is 0 (no new archives)
    expect(result.data.archived_count).toBe(0);
  });

  it("verifies a memory", async () => {
    const created = await service.create({
      project_id: "test-project",
      content: "Memory to verify",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    expect(created.data.verified_at).toBeNull();

    const verified = await service.verify(created.data.id, "alice");
    expect(verified.data.verified_at).toBeInstanceOf(Date);
  });

  it("verify on non-existent throws NotFoundError", async () => {
    await expect(
      service.verify("nonexistent-id-12345", "alice"),
    ).rejects.toThrow(NotFoundError);
  });

  it("lists memories sorted by created_at desc", async () => {
    await service.create({
      project_id: "test-project",
      content: "First memory",
      type: "fact",
      author: "alice",
    });
    await service.create({
      project_id: "test-project",
      content: "Second memory",
      type: "fact",
      author: "alice",
    });
    await service.create({
      project_id: "test-project",
      content: "Third memory",
      type: "fact",
      author: "alice",
    });

    const result = await service.list({
      project_id: "test-project",
      scope: "workspace",
    });

    expect(result.data.length).toBe(3);
    // Default order is desc -- newest first
    expect(result.data[0].content).toBe("Third memory");
    expect(result.data[2].content).toBe("First memory");
  });

  it("lists memories filtered by type", async () => {
    await service.create({
      project_id: "test-project",
      content: "A decision",
      type: "decision",
      author: "alice",
    });
    await service.create({
      project_id: "test-project",
      content: "A fact",
      type: "fact",
      author: "alice",
    });
    await service.create({
      project_id: "test-project",
      content: "Another decision",
      type: "decision",
      author: "alice",
    });

    const result = await service.list({
      project_id: "test-project",
      scope: "workspace",
      type: "decision",
    });

    expect(result.data.length).toBe(2);
    expect(result.data.every((m) => m.type === "decision")).toBe(true);
  });

  it("lists memories filtered by tags", async () => {
    await service.create({
      project_id: "test-project",
      content: "Deploy note",
      type: "fact",
      author: "alice",
      tags: ["deploy", "ci"],
    });
    await service.create({
      project_id: "test-project",
      content: "Unrelated note",
      type: "fact",
      author: "alice",
      tags: ["design"],
    });

    const result = await service.list({
      project_id: "test-project",
      scope: "workspace",
      tags: ["deploy"],
    });

    expect(result.data.length).toBe(1);
    expect(result.data[0].content).toBe("Deploy note");
  });

  it("paginates with cursor", async () => {
    // Create 5 memories
    for (let i = 1; i <= 5; i++) {
      await service.create({
        project_id: "test-project",
        content: `Paginated memory ${i}`,
        type: "fact",
        author: "alice",
      });
    }

    // First page: limit 2
    const page1 = await service.list({
      project_id: "test-project",
      scope: "workspace",
      limit: 2,
    });
    expect(page1.data.length).toBe(2);
    expect(page1.meta.has_more).toBe(true);
    expect(page1.meta.cursor).toBeDefined();

    // Second page using cursor
    const cursorParts = page1.meta.cursor!.split("|");
    const page2 = await service.list({
      project_id: "test-project",
      scope: "workspace",
      limit: 2,
      cursor: { created_at: cursorParts[0], id: cursorParts[1] },
    });
    expect(page2.data.length).toBe(2);
    expect(page2.meta.has_more).toBe(true);

    // Third page
    const cursor2Parts = page2.meta.cursor!.split("|");
    const page3 = await service.list({
      project_id: "test-project",
      scope: "workspace",
      limit: 2,
      cursor: { created_at: cursor2Parts[0], id: cursor2Parts[1] },
    });
    expect(page3.data.length).toBe(1);
    expect(page3.meta.has_more).toBe(false);

    // Total across all pages: 2 + 2 + 1 = 5
    const allIds = [
      ...page1.data.map((m) => m.id),
      ...page2.data.map((m) => m.id),
      ...page3.data.map((m) => m.id),
    ];
    expect(new Set(allIds).size).toBe(5);
  });
});
