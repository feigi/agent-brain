import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  getTestDb,
  truncateAll,
  closeDb,
  assertMemory,
  createTestService,
} from "../helpers.js";
import { DrizzleRelationshipRepository } from "../../src/repositories/relationship-repository.js";
import { DrizzleWorkspaceRepository } from "../../src/repositories/workspace-repository.js";
import { generateId } from "../../src/utils/id.js";
import type { Relationship } from "../../src/types/relationship.js";

describe("relationship repository", () => {
  let repo: DrizzleRelationshipRepository;
  let sourceId: string;
  let targetId: string;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    repo = new DrizzleRelationshipRepository(db);

    const workspaceRepo = new DrizzleWorkspaceRepository(db);
    await workspaceRepo.findOrCreate("test-ws");

    const service = createTestService();

    const sourceResult = await service.create({
      workspace_id: "test-ws",
      content: "source memory content",
      type: "fact",
      author: "alice",
    });
    assertMemory(sourceResult.data);
    sourceId = sourceResult.data.id;

    const targetResult = await service.create({
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

  function makeRelationship(
    overrides: Partial<Relationship> = {},
  ): Relationship {
    return {
      id: generateId(),
      project_id: "test-project",
      source_id: sourceId,
      target_id: targetId,
      type: "overrides",
      description: null,
      confidence: 1.0,
      created_by: "alice",
      source: "manual",
      archived_at: null,
      created_at: new Date(),
      ...overrides,
    };
  }

  it("creates and retrieves a relationship", async () => {
    const rel = makeRelationship({ description: "source overrides target" });
    await repo.create(rel);

    const found = await repo.findById(rel.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(rel.id);
    expect(found!.source_id).toBe(sourceId);
    expect(found!.target_id).toBe(targetId);
    expect(found!.type).toBe("overrides");
    expect(found!.description).toBe("source overrides target");
  });

  it("returns outgoing and incoming relationships separately", async () => {
    const thirdResult = await createTestService().create({
      workspace_id: "test-ws",
      content: "third memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(thirdResult.data);
    const thirdId = thirdResult.data.id;

    // sourceId -> targetId (outgoing from sourceId)
    await repo.create(
      makeRelationship({
        id: generateId(),
        source_id: sourceId,
        target_id: targetId,
      }),
    );
    // thirdId -> sourceId (incoming to sourceId)
    await repo.create(
      makeRelationship({
        id: generateId(),
        source_id: thirdId,
        target_id: sourceId,
        type: "refines",
      }),
    );

    const outgoing = await repo.findByMemoryId(
      "test-project",
      sourceId,
      "outgoing",
    );
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].target_id).toBe(targetId);

    const incoming = await repo.findByMemoryId(
      "test-project",
      sourceId,
      "incoming",
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0].source_id).toBe(thirdId);

    const both = await repo.findByMemoryId("test-project", sourceId, "both");
    expect(both).toHaveLength(2);
  });

  it("enforces unique constraint on (project_id, source_id, target_id, type)", async () => {
    await repo.create(makeRelationship({ id: generateId() }));
    await expect(
      repo.create(makeRelationship({ id: generateId() })),
    ).rejects.toThrow();
  });

  it("findExisting returns matching relationship", async () => {
    const rel = makeRelationship();
    await repo.create(rel);

    const found = await repo.findExisting(
      "test-project",
      sourceId,
      targetId,
      "overrides",
    );
    expect(found).not.toBeNull();
    expect(found!.id).toBe(rel.id);
  });

  it("findExisting returns null when no match", async () => {
    const found = await repo.findExisting(
      "test-project",
      sourceId,
      targetId,
      "overrides",
    );
    expect(found).toBeNull();
  });

  it("soft-deletes relationships when archiveByMemoryId is called", async () => {
    await repo.create(makeRelationship({ id: generateId() }));

    const count = await repo.archiveByMemoryId(sourceId);
    expect(count).toBe(1);

    // Should not be visible via findById (soft-deleted)
    const outgoing = await repo.findByMemoryId(
      "test-project",
      sourceId,
      "outgoing",
    );
    expect(outgoing).toHaveLength(0);
  });

  it("archives relationships on both sides when archiveByMemoryId is called", async () => {
    // sourceId -> targetId
    await repo.create(
      makeRelationship({
        id: generateId(),
        source_id: sourceId,
        target_id: targetId,
      }),
    );
    // targetId is also a target — archive by targetId
    const count = await repo.archiveByMemoryId(targetId);
    expect(count).toBe(1);

    const incoming = await repo.findByMemoryId(
      "test-project",
      targetId,
      "incoming",
    );
    expect(incoming).toHaveLength(0);
  });

  it("deletes a relationship by id", async () => {
    const rel = makeRelationship();
    await repo.create(rel);

    const deleted = await repo.deleteById(rel.id);
    expect(deleted).toBe(true);

    const found = await repo.findById(rel.id);
    expect(found).toBeNull();
  });

  it("deleteById returns false for non-existent id", async () => {
    const deleted = await repo.deleteById("non-existent-id");
    expect(deleted).toBe(false);
  });

  it("filters by type", async () => {
    await repo.create(
      makeRelationship({ id: generateId(), type: "overrides" }),
    );

    // Need a second target for the refines relationship
    const anotherResult = await createTestService().create({
      workspace_id: "test-ws",
      content: "another memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(anotherResult.data);

    await repo.create(
      makeRelationship({
        id: generateId(),
        target_id: anotherResult.data.id,
        type: "refines",
      }),
    );

    const overrides = await repo.findByMemoryId(
      "test-project",
      sourceId,
      "outgoing",
      "overrides",
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0].type).toBe("overrides");

    const refines = await repo.findByMemoryId(
      "test-project",
      sourceId,
      "outgoing",
      "refines",
    );
    expect(refines).toHaveLength(1);
    expect(refines[0].type).toBe("refines");
  });

  it("findBetweenMemories returns relationships among a set of memory IDs", async () => {
    const thirdResult = await createTestService().create({
      workspace_id: "test-ws",
      content: "third memory for between test",
      type: "fact",
      author: "alice",
    });
    assertMemory(thirdResult.data);
    const thirdId = thirdResult.data.id;

    // sourceId -> targetId (both in set)
    await repo.create(
      makeRelationship({
        id: generateId(),
        source_id: sourceId,
        target_id: targetId,
      }),
    );
    // sourceId -> thirdId (thirdId NOT in set)
    await repo.create(
      makeRelationship({
        id: generateId(),
        source_id: sourceId,
        target_id: thirdId,
        type: "refines",
      }),
    );

    // Only ask for sourceId and targetId — thirdId excluded
    const between = await repo.findBetweenMemories("test-project", [
      sourceId,
      targetId,
    ]);
    expect(between).toHaveLength(1);
    expect(between[0].source_id).toBe(sourceId);
    expect(between[0].target_id).toBe(targetId);
  });

  it("findBetweenMemories returns empty array for fewer than 2 IDs", async () => {
    const result = await repo.findBetweenMemories("test-project", [sourceId]);
    expect(result).toHaveLength(0);
  });
});
