import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  getTestDb,
  truncateAll,
  closeDb,
  assertMemory,
  createTestService,
} from "../helpers.js";
import { DrizzleRelationshipRepository } from "../../src/repositories/relationship-repository.js";
import { DrizzleMemoryRepository } from "../../src/repositories/memory-repository.js";
import { DrizzleWorkspaceRepository } from "../../src/repositories/workspace-repository.js";
import { RelationshipService } from "../../src/services/relationship-service.js";
import { NotFoundError, ValidationError } from "../../src/utils/errors.js";
import { generateId } from "../../src/utils/id.js";

describe("RelationshipService", () => {
  let service: RelationshipService;
  let sourceId: string;
  let targetId: string;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();

    const workspaceRepo = new DrizzleWorkspaceRepository(db);
    await workspaceRepo.findOrCreate("test-ws");

    const memoryRepo = new DrizzleMemoryRepository(db);
    const relationshipRepo = new DrizzleRelationshipRepository(db);
    service = new RelationshipService(
      relationshipRepo,
      memoryRepo,
      "test-project",
    );

    const memService = createTestService();

    const sourceResult = await memService.create({
      workspace_id: "test-ws",
      content: "source memory content",
      type: "fact",
      author: "alice",
    });
    assertMemory(sourceResult.data);
    sourceId = sourceResult.data.id;

    const targetResult = await memService.create({
      workspace_id: "test-ws",
      content: "target memory content",
      type: "fact",
      author: "alice",
    });
    assertMemory(targetResult.data);
    targetId = targetResult.data.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("create", () => {
    it("creates a relationship and returns it", async () => {
      const rel = await service.create({
        sourceId,
        targetId,
        type: "overrides",
        description: "source overrides target",
        userId: "alice",
      });

      expect(rel.id).toBeDefined();
      expect(rel.source_id).toBe(sourceId);
      expect(rel.target_id).toBe(targetId);
      expect(rel.type).toBe("overrides");
      expect(rel.description).toBe("source overrides target");
      expect(rel.project_id).toBe("test-project");
    });

    it("returns existing relationship on duplicate create", async () => {
      const first = await service.create({
        sourceId,
        targetId,
        type: "overrides",
        userId: "alice",
      });

      const second = await service.create({
        sourceId,
        targetId,
        type: "overrides",
        userId: "alice",
      });

      expect(second.id).toBe(first.id);
    });

    it("throws NotFoundError if source memory does not exist", async () => {
      await expect(
        service.create({
          sourceId: "non-existent-id",
          targetId,
          type: "overrides",
          userId: "alice",
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it("throws ValidationError if source equals target", async () => {
      await expect(
        service.create({
          sourceId,
          targetId: sourceId,
          type: "overrides",
          userId: "alice",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws NotFoundError if user cannot access source memory (user-scoped by another user)", async () => {
      const memService = createTestService();
      const privateResult = await memService.create({
        workspace_id: "test-ws",
        content: "private memory",
        type: "fact",
        author: "alice",
        scope: "user",
      });
      assertMemory(privateResult.data);
      const privateId = privateResult.data.id;

      await expect(
        service.create({
          sourceId: privateId,
          targetId,
          type: "overrides",
          userId: "bob", // different user
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe("listForMemory", () => {
    it("lists relationships with enriched memory summaries (direction, related_memory)", async () => {
      await service.create({
        sourceId,
        targetId,
        type: "overrides",
        userId: "alice",
      });

      const results = await service.listForMemory(
        sourceId,
        "outgoing",
        "alice",
      );

      expect(results).toHaveLength(1);
      expect(results[0].direction).toBe("outgoing");
      expect(results[0].related_memory).toBeDefined();
      expect(results[0].related_memory.id).toBe(targetId);
      expect(results[0].related_memory.title).toBeDefined();
      expect(results[0].related_memory.type).toBeDefined();
      expect(results[0].related_memory.scope).toBeDefined();
    });
  });

  describe("remove", () => {
    it("removes a relationship", async () => {
      const rel = await service.create({
        sourceId,
        targetId,
        type: "overrides",
        userId: "alice",
      });

      await expect(service.remove(rel.id, "alice")).resolves.toBeUndefined();

      // After removal, listing should return empty
      const results = await service.listForMemory(
        sourceId,
        "outgoing",
        "alice",
      );
      expect(results).toHaveLength(0);
    });

    it("throws NotFoundError when removing non-existent relationship", async () => {
      await expect(service.remove("non-existent-id", "alice")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("allows either-side access for consolidation-created relationships", async () => {
      const db = getTestDb();
      const memService = createTestService();

      // Bob creates a user-scoped memory
      const bobResult = await memService.create({
        workspace_id: "test-ws",
        content: "bob's private memory",
        type: "fact",
        author: "bob",
        scope: "user",
      });
      assertMemory(bobResult.data);
      const bobMemoryId = bobResult.data.id;

      // Alice creates a workspace-scoped memory
      const aliceResult = await memService.create({
        workspace_id: "test-ws",
        content: "alice's workspace memory",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(aliceResult.data);
      const aliceMemoryId = aliceResult.data.id;

      // Use the repo directly to create a consolidation-sourced relationship
      const relationshipRepo = new DrizzleRelationshipRepository(db);
      const rel = await relationshipRepo.create({
        id: generateId(),
        project_id: "test-project",
        source_id: bobMemoryId,
        target_id: aliceMemoryId,
        type: "related",
        description: null,
        confidence: 1.0,
        created_by: "system",
        created_via: "consolidation",
        archived_at: null,
        created_at: new Date(),
      });

      // Alice can remove it — she can access the workspace side (aliceMemoryId) but not bob's user-scoped side
      await expect(service.remove(rel.id, "alice")).resolves.toBeUndefined();
    });

    it("throws NotFoundError when non-source-owner tries to remove non-consolidation relationship", async () => {
      const memService = createTestService();

      // Alice creates a user-scoped memory (source)
      const aliceResult = await memService.create({
        workspace_id: "test-ws",
        content: "alice's private memory",
        type: "fact",
        author: "alice",
        scope: "user",
      });
      assertMemory(aliceResult.data);
      const aliceMemoryId = aliceResult.data.id;

      // Bob creates a workspace memory (target — accessible to everyone)
      const bobResult = await memService.create({
        workspace_id: "test-ws",
        content: "workspace memory by bob",
        type: "fact",
        author: "bob",
        scope: "workspace",
      });
      assertMemory(bobResult.data);
      const bobMemoryId = bobResult.data.id;

      // Alice creates a manual relationship (source = her private memory)
      const rel = await service.create({
        sourceId: aliceMemoryId,
        targetId: bobMemoryId,
        type: "overrides",
        userId: "alice",
      });

      // Bob can access the target but NOT the source — should be denied
      await expect(service.remove(rel.id, "bob")).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe("listBetweenMemories", () => {
    it("returns relationships between a set of memory IDs", async () => {
      await service.create({
        sourceId,
        targetId,
        type: "related",
        userId: "alice",
      });

      const results = await service.listBetweenMemories(
        [sourceId, targetId],
        "alice",
      );

      expect(results).toHaveLength(1);
      expect(results[0].direction).toBe("outgoing");
      expect(results[0].related_memory.id).toBe(targetId);
    });
  });

  describe("listForMemory access control", () => {
    it("throws NotFoundError when querying another user's user-scoped memory", async () => {
      const memService = createTestService();

      // Create Bob's user-scoped memory
      const bobResult = await memService.create({
        workspace_id: "test-ws",
        content: "bob's private memory",
        type: "fact",
        author: "bob",
        scope: "user",
      });
      assertMemory(bobResult.data);

      // Alice tries to list relationships for Bob's private memory
      await expect(
        service.listForMemory(bobResult.data.id, "both", "alice"),
      ).rejects.toThrow(NotFoundError);
    });

    it("excludes relationships where related memory is inaccessible", async () => {
      const memService = createTestService();

      // Create a workspace memory
      const wsResult = await memService.create({
        workspace_id: "test-ws",
        content: "workspace memory",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(wsResult.data);
      const wsMemoryId = wsResult.data.id;

      // Create Bob's user-scoped memory
      const bobResult = await memService.create({
        workspace_id: "test-ws",
        content: "bob's private memory",
        type: "fact",
        author: "bob",
        scope: "user",
      });
      assertMemory(bobResult.data);
      const bobMemoryId = bobResult.data.id;

      // Bob creates a relationship from workspace → his private memory
      await service.create({
        sourceId: wsMemoryId,
        targetId: bobMemoryId,
        type: "refines",
        userId: "bob",
      });

      // Alice lists relationships for the workspace memory — Bob's memory is inaccessible
      const results = await service.listForMemory(
        wsMemoryId,
        "outgoing",
        "alice",
      );
      expect(results).toHaveLength(0);
    });
  });

  describe("archiveByMemoryId", () => {
    it("soft-deletes relationships", async () => {
      await service.create({
        sourceId,
        targetId,
        type: "related",
        userId: "alice",
      });

      await service.archiveByMemoryId(sourceId);

      const results = await service.listForMemory(
        sourceId,
        "outgoing",
        "alice",
      );
      expect(results).toHaveLength(0);
    });
  });
});
