import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createTestService,
  truncateAll,
  closeDb,
  assertMemory,
} from "../helpers.js";
import type { MemoryService } from "../../src/services/memory-service.js";

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
      project_id: "test-project",
      content: "Database migration patterns for PostgreSQL schema evolution",
      type: "fact",
      scope: "workspace",
      author: "alice",
    });
    await service.create({
      project_id: "test-project",
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
      project_id: "test-project",
      content: "First memory created for recency test",
      type: "fact",
      scope: "workspace",
      author: "alice",
    });
    await service.create({
      project_id: "test-project",
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
        project_id: "test-project",
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
        project_id: "test-project",
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
      project_id: "other-project",
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
      project_id: "test-project",
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

  it("response envelope has count and timing (D-18)", async () => {
    await service.create({
      project_id: "test-project",
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
