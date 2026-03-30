import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createTestService, truncateAll, closeDb } from "../helpers.js";
import type { MemoryService } from "../../src/services/memory-service.js";

/**
 * Duplicate detection integration tests (AUTO-05).
 *
 * The mock embedding provider is deterministic and hash-based: identical text produces
 * identical vectors (cosine similarity = 1.0), while different text produces different
 * vectors. This is used to reliably trigger and avoid dedup detection.
 *
 * Note: These tests use source: 'manual' to avoid budget complications.
 */
describe("Semantic duplicate detection integration tests", () => {
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    service = createTestService();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("identical content is detected as duplicate (AUTO-05)", async () => {
    const content =
      "Always use parameterized queries to prevent SQL injection vulnerabilities";

    // Create the original memory
    const original = await service.create({
      project_id: "test-project",
      content,
      type: "decision",
      author: "alice",
      source: "manual",
    });
    expect(original.data).toHaveProperty("id");

    // Try to create a memory with identical content
    const duplicate = await service.create({
      project_id: "test-project",
      content, // exactly the same content
      type: "decision",
      author: "alice",
      source: "manual",
    });

    expect("skipped" in duplicate.data && duplicate.data.skipped).toBe(true);
    if ("skipped" in duplicate.data) {
      expect(duplicate.data.reason).toBe("duplicate");
      // The duplicate info should reference the original memory's id
      if ("id" in original.data) {
        expect(duplicate.data.duplicate?.id).toBe(original.data.id);
      }
    }
  });

  it("completely different content passes dedup", async () => {
    await service.create({
      project_id: "test-project",
      content:
        "A completely unique insight about PostgreSQL index performance and HNSW tuning",
      type: "fact",
      author: "alice",
      source: "manual",
    });

    const result = await service.create({
      project_id: "test-project",
      content:
        "A totally different observation about unit testing with vitest mocks and dependency injection",
      type: "learning",
      author: "alice",
      source: "manual",
    });

    expect(result.data).toHaveProperty("id");
    expect("skipped" in result.data).toBe(false);
  });

  it("project-scoped dedup checks project scope only", async () => {
    // D-16: Project-scoped dedup checks WHERE project_id = $projectId (includes all memories in project).
    // This means project memories and user memories in the same project are compared.
    // The key invariant: project dedup does NOT check user memories from OTHER projects.
    //
    // To test the cross-project isolation: create a user-scoped memory in project-A,
    // then attempt project-scoped memory in project-B with same content.
    const content =
      "Shared infrastructure insight about container networking configuration";

    // Create a user-scoped memory in project-A
    await service.create({
      project_id: "project-a",
      content,
      type: "fact",
      scope: "user",
      author: "alice",
      source: "manual",
    });

    // Attempt to create a project-scoped memory in project-B with identical content
    // Project-B's dedup only checks project-B's memories, not project-A's
    const result = await service.create({
      project_id: "project-b",
      content,
      type: "fact",
      scope: "workspace",
      author: "alice",
      source: "manual",
    });

    // project-B memory should NOT be flagged as duplicate (original is in project-A)
    expect(result.data).toHaveProperty("id");
    expect("skipped" in result.data).toBe(false);
  });

  it("user-scoped dedup checks both user and project scope (D-16)", async () => {
    const content =
      "Architecture decision: use event sourcing for audit trail requirements";

    // Create a project-scoped memory
    const original = await service.create({
      project_id: "test-project",
      content,
      type: "architecture",
      scope: "workspace",
      author: "alice",
      source: "manual",
    });
    expect(original.data).toHaveProperty("id");

    // Try to create a user-scoped memory with identical content
    // D-16: User dedup checks BOTH user and project scope
    const result = await service.create({
      project_id: "test-project",
      content, // identical content
      type: "architecture",
      scope: "user",
      author: "alice",
      source: "manual",
    });

    expect("skipped" in result.data && result.data.skipped).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("duplicate");
      // Cross-scope message should mention shared knowledge
      expect(result.data.message).toContain("shared knowledge");
    }
  });

  it("dedup response includes existing memory info (id, title, relevance)", async () => {
    // Use identical content AND no explicit title so both creates auto-generate the same title,
    // producing identical embeddings (title\n\ncontent).
    const content =
      "Critical security insight: always validate and sanitize user input on the server side";

    const original = await service.create({
      project_id: "test-project",
      content,
      // no explicit title -- auto-generated from content
      type: "decision",
      author: "alice",
      source: "manual",
    });

    expect(original.data).toHaveProperty("id");

    const result = await service.create({
      project_id: "test-project",
      content,
      // no explicit title -- auto-generated from same content = identical embedding
      type: "decision",
      author: "alice",
      source: "manual",
    });

    if ("skipped" in result.data && result.data.skipped) {
      expect(result.data.duplicate).toBeDefined();
      expect(result.data.duplicate?.id).toBeTypeOf("string");
      expect(result.data.duplicate?.title).toBeTypeOf("string");
      expect(result.data.duplicate?.relevance).toBeTypeOf("number");
      expect(result.data.duplicate?.relevance).toBeGreaterThan(0.9);

      if ("id" in original.data) {
        expect(result.data.duplicate?.id).toBe(original.data.id);
      }
    } else {
      // This should not happen -- the test data should produce a duplicate
      expect.fail("Expected duplicate detection but got a successful create");
    }
  });

  it("archived memories are excluded from dedup check", async () => {
    const content =
      "Transient debugging observation: database connection pool exhausted under load";

    // Create original memory
    const original = await service.create({
      project_id: "test-project",
      content,
      type: "fact",
      author: "alice",
      source: "manual",
    });

    if (!("id" in original.data)) {
      expect.fail("Original memory creation failed");
      return;
    }

    // Archive the original memory
    await service.archive(original.data.id, "alice");

    // Now create another memory with identical content -- should succeed since original is archived
    const result = await service.create({
      project_id: "test-project",
      content,
      type: "fact",
      author: "alice",
      source: "manual",
    });

    // Archived memories are excluded from dedup, so this should succeed
    expect(result.data).toHaveProperty("id");
    expect("skipped" in result.data).toBe(false);
  });
});
