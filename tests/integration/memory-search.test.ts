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
      undefined,
      undefined,
      0, // allow any relevance -- mock embeddings have low scores
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
      undefined,
      2,
      0, // allow any relevance -- mock embeddings have low scores
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

    await service.archive(created.data.id);

    const result = await service.search(
      "archived memory search",
      "test-project",
      "project",
    );

    const archivedInResults = result.data.find(
      (m) => m.id === created.data.id,
    );
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
      undefined,
      undefined,
      0.99,
    );

    // With 0.99 threshold, mock embeddings are unlikely to produce a match
    expect(result.data.length).toBe(0);
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
      undefined,
      undefined,
      0, // allow any relevance
    );

    expect(result.data.length).toBeGreaterThan(0);
    for (const memory of result.data) {
      expect(memory.relevance).toBeTypeOf("number");
      expect(memory.relevance).toBeGreaterThan(0);
      expect(memory.relevance).toBeLessThanOrEqual(1);
    }
  });
});
