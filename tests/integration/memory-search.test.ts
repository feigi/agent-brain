import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createTestService, truncateAll, closeDb } from "../helpers.js";
import type { MemoryService } from "../../src/services/memory-service.js";

describe("Memory search integration tests", () => {
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    service = createTestService();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns results ranked by relevance (highest first)", async () => {
    // Create memories with distinct content
    await service.create({
      project_id: "test-project",
      content: "database migration patterns and schema evolution",
      type: "fact",
      author: "alice",
    });
    await service.create({
      project_id: "test-project",
      content: "UI component styling with CSS modules and Tailwind",
      type: "fact",
      author: "alice",
    });
    await service.create({
      project_id: "test-project",
      content: "database connection pooling and query optimization",
      type: "fact",
      author: "alice",
    });

    const result = await service.search(
      "database",
      "test-project",
      "project",
      "alice",
      undefined,
      -1, // negative threshold ensures mock embeddings with any cosine similarity pass through
    );

    // Should return results with relevance scores in descending order
    expect(result.data.length).toBeGreaterThan(0);
    for (let i = 1; i < result.data.length; i++) {
      expect(result.data[i - 1].relevance).toBeGreaterThanOrEqual(
        result.data[i].relevance,
      );
    }
  });

  it("respects limit parameter", async () => {
    // Create 5 memories
    for (let i = 1; i <= 5; i++) {
      await service.create({
        project_id: "test-project",
        content: `Search content item number ${i}`,
        type: "fact",
        author: "alice",
      });
    }

    const result = await service.search(
      "search content",
      "test-project",
      "project",
      "alice",
      2,
      -1, // negative threshold ensures mock embeddings with any cosine similarity pass through
    );

    expect(result.data.length).toBeLessThanOrEqual(2);
  });

  it("excludes archived memories from search", async () => {
    const created = await service.create({
      project_id: "test-project",
      content: "This memory will be archived and should not appear in search",
      type: "fact",
      author: "alice",
    });

    await service.archive(created.data.id, "alice");

    const result = await service.search(
      "archived memory search",
      "test-project",
      "project",
      "alice",
    );

    const archivedInResults = result.data.find((m) => m.id === created.data.id);
    expect(archivedInResults).toBeUndefined();
  });

  it("filters by min_relevance threshold", async () => {
    await service.create({
      project_id: "test-project",
      content: "Some generic content",
      type: "fact",
      author: "alice",
    });

    // Very high threshold should exclude most/all results
    const result = await service.search(
      "completely unrelated query xyz",
      "test-project",
      "project",
      "alice",
      undefined,
      0.99,
    );

    // With 0.99 threshold, mock embeddings are unlikely to produce a match
    expect(result.data.length).toBe(0);
  });

  it("cross-scope search returns both project and user memories (SCOP-03)", async () => {
    // Create a project-scoped memory
    await service.create({
      project_id: "test-project",
      content: "Project-specific deployment configuration notes",
      type: "fact",
      scope: "project",
      author: "alice",
    });
    // Create a user-scoped memory
    await service.create({
      project_id: "test-project",
      content: "User alice deployment preferences and patterns",
      type: "preference",
      scope: "user",
      author: "alice",
    });

    const result = await service.search(
      "deployment",
      "test-project",
      "both",
      "alice",
      undefined,
      -1, // negative threshold ensures mock embeddings with any cosine similarity pass through
    );

    expect(result.data.length).toBe(2);
    const scopes = result.data.map((m) => m.scope);
    expect(scopes).toContain("project");
    expect(scopes).toContain("user");
    // All results have relevance field
    for (const memory of result.data) {
      expect(memory).toHaveProperty("relevance");
      expect(
        (memory as unknown as Record<string, unknown>).similarity,
      ).toBeUndefined();
    }
  });

  it("cross-scope search with both scopes requires user_id (D-09)", async () => {
    // user_id is now a required parameter -- repository enforces it for scope='both'
    // Passing a valid user_id must work without error
    const result = await service.search(
      "test",
      "test-project",
      "both",
      "alice",
      undefined,
      -1,
    );
    expect(result.data).toBeInstanceOf(Array);
  });

  it("search results include relevance score between 0 and 1", async () => {
    await service.create({
      project_id: "test-project",
      content: "Testing relevance scores in search results",
      type: "fact",
      author: "alice",
    });

    const result = await service.search(
      "relevance scores",
      "test-project",
      "project",
      "alice",
      undefined,
      -1, // negative threshold ensures mock embeddings with any cosine similarity pass through
    );

    expect(result.data.length).toBeGreaterThan(0);
    for (const memory of result.data) {
      expect(memory.relevance).toBeTypeOf("number");
      expect(memory.relevance).toBeGreaterThanOrEqual(0); // composite score is clamped to [0, 1]
      expect(memory.relevance).toBeLessThanOrEqual(1);
    }
  });
});
