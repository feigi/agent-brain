import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { z } from "zod";
import {
  getTestDb,
  truncateAll,
  closeDb,
  assertMemory,
  createTestServiceWithRelationships,
} from "../helpers.js";
import { DrizzleWorkspaceRepository } from "../../src/repositories/workspace-repository.js";
import { toolSchemas } from "../../src/routes/api-schemas.js";

describe("relationship API schemas", () => {
  describe("memory_relate schema", () => {
    const schema = toolSchemas.memory_relate;

    it("accepts valid input with all fields", () => {
      const result = schema.parse({
        source_id: "mem_abc",
        target_id: "mem_def",
        type: "overrides",
        description: "source supersedes target",
        confidence: 0.95,
        user_id: "alice",
        created_via: "manual",
      });
      expect(result.source_id).toBe("mem_abc");
      expect(result.confidence).toBe(0.95);
      expect(result.created_via).toBe("manual");
    });

    it("accepts minimal input (only required fields)", () => {
      const result = schema.parse({
        source_id: "mem_abc",
        target_id: "mem_def",
        type: "overrides",
        user_id: "alice",
      });
      expect(result.description).toBeUndefined();
      expect(result.confidence).toBeUndefined();
      expect(result.created_via).toBeUndefined();
    });

    it("rejects empty source_id", () => {
      expect(() =>
        schema.parse({
          source_id: "",
          target_id: "mem_def",
          type: "overrides",
          user_id: "alice",
        }),
      ).toThrow(z.ZodError);
    });

    it("rejects confidence outside 0-1 range", () => {
      expect(() =>
        schema.parse({
          source_id: "mem_abc",
          target_id: "mem_def",
          type: "overrides",
          user_id: "alice",
          confidence: 1.5,
        }),
      ).toThrow(z.ZodError);
    });

    it("rejects type longer than 64 characters", () => {
      expect(() =>
        schema.parse({
          source_id: "mem_abc",
          target_id: "mem_def",
          type: "a".repeat(65),
          user_id: "alice",
        }),
      ).toThrow(z.ZodError);
    });
  });

  describe("memory_unrelate schema", () => {
    const schema = toolSchemas.memory_unrelate;

    it("accepts valid input", () => {
      const result = schema.parse({ id: "rel_123", user_id: "alice" });
      expect(result.id).toBe("rel_123");
    });

    it("rejects missing id", () => {
      expect(() => schema.parse({ user_id: "alice" })).toThrow(z.ZodError);
    });
  });

  describe("memory_relationships schema", () => {
    const schema = toolSchemas.memory_relationships;

    it("defaults direction to both", () => {
      const result = schema.parse({
        memory_ids: ["mem_abc"],
        user_id: "alice",
      });
      expect(result.direction).toBe("both");
    });

    it("accepts multiple memory_ids", () => {
      const result = schema.parse({
        memory_ids: ["mem_abc", "mem_def"],
        user_id: "alice",
        direction: "outgoing",
      });
      expect(result.memory_ids).toEqual(["mem_abc", "mem_def"]);
      expect(result.direction).toBe("outgoing");
    });

    it("rejects empty memory_ids array", () => {
      expect(() => schema.parse({ memory_ids: [], user_id: "alice" })).toThrow(
        z.ZodError,
      );
    });

    it("rejects invalid direction", () => {
      expect(() =>
        schema.parse({
          memory_ids: ["mem_abc"],
          user_id: "alice",
          direction: "sideways",
        }),
      ).toThrow(z.ZodError);
    });
  });
});

describe("relationship API response shaping", () => {
  let memoryService: ReturnType<
    typeof createTestServiceWithRelationships
  >["memoryService"];
  let relationshipService: ReturnType<
    typeof createTestServiceWithRelationships
  >["relationshipService"];

  beforeEach(async () => {
    await truncateAll();
    const services = createTestServiceWithRelationships();
    memoryService = services.memoryService;
    relationshipService = services.relationshipService;

    const workspaceRepo = new DrizzleWorkspaceRepository(getTestDb());
    await workspaceRepo.findOrCreate("test-ws");
  });

  afterAll(async () => {
    await closeDb();
  });

  it("memory_relate returns the created relationship with all fields", async () => {
    const s = await memoryService.create({
      workspace_id: "test-ws",
      content: "source",
      type: "fact",
      author: "alice",
    });
    assertMemory(s.data);
    const t = await memoryService.create({
      workspace_id: "test-ws",
      content: "target",
      type: "fact",
      author: "alice",
    });
    assertMemory(t.data);

    const result = await relationshipService.create({
      sourceId: s.data.id,
      targetId: t.data.id,
      type: "overrides",
      description: "test",
      confidence: 0.9,
      userId: "alice",
      createdVia: "manual",
    });

    expect(result).toMatchObject({
      source_id: s.data.id,
      target_id: t.data.id,
      type: "overrides",
      description: "test",
      confidence: 0.9,
      created_via: "manual",
    });
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeInstanceOf(Date);
  });

  it("memory_relationships returns enriched results with direction and related_memory", async () => {
    const s = await memoryService.create({
      workspace_id: "test-ws",
      content: "source",
      type: "fact",
      author: "alice",
    });
    assertMemory(s.data);
    const t = await memoryService.create({
      workspace_id: "test-ws",
      content: "target",
      type: "fact",
      author: "alice",
    });
    assertMemory(t.data);

    await relationshipService.create({
      sourceId: s.data.id,
      targetId: t.data.id,
      type: "overrides",
      userId: "alice",
    });

    const results = await relationshipService.listForMemory(
      s.data.id,
      "both",
      "alice",
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      direction: "outgoing",
      related_memory: {
        id: t.data.id,
        type: "fact",
        scope: "workspace",
      },
    });
    expect(results[0]).toHaveProperty("created_via");
  });

  it("memory_unrelate soft-deletes (relationship no longer appears in queries)", async () => {
    const s = await memoryService.create({
      workspace_id: "test-ws",
      content: "source",
      type: "fact",
      author: "alice",
    });
    assertMemory(s.data);
    const t = await memoryService.create({
      workspace_id: "test-ws",
      content: "target",
      type: "fact",
      author: "alice",
    });
    assertMemory(t.data);

    const rel = await relationshipService.create({
      sourceId: s.data.id,
      targetId: t.data.id,
      type: "overrides",
      userId: "alice",
    });

    await relationshipService.remove(rel.id, "alice");

    const results = await relationshipService.listForMemory(
      s.data.id,
      "both",
      "alice",
    );
    expect(results).toHaveLength(0);
  });
});
