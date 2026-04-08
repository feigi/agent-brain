import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  getTestDb,
  truncateAll,
  closeDb,
  assertMemory,
  createTestService,
  createTestServiceWithRelationships,
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
      created_via: "manual",
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

  it("archives a relationship by id", async () => {
    const rel = makeRelationship();
    await repo.create(rel);

    const archived = await repo.archiveById(rel.id);
    expect(archived).toBe(true);

    const found = await repo.findById(rel.id);
    expect(found).toBeNull();
  });

  it("archiveById returns false for non-existent id", async () => {
    const archived = await repo.archiveById("non-existent-id");
    expect(archived).toBe(false);
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

describe("session_start includes relationships between returned memories", () => {
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

  it("returns relationships between session_start memories in meta", async () => {
    // Create two memories
    const sourceResult = await memoryService.create({
      workspace_id: "test-ws",
      content: "session start source memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(sourceResult.data);
    const sourceId = sourceResult.data.id;

    const targetResult = await memoryService.create({
      workspace_id: "test-ws",
      content: "session start target memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(targetResult.data);
    const targetId = targetResult.data.id;

    // Create an overrides relationship between them
    await relationshipService.create({
      sourceId,
      targetId,
      type: "overrides",
      userId: "alice",
    });

    // Call sessionStart
    const result = await memoryService.sessionStart("test-ws", "alice");

    // Both memories should be returned
    const returnedIds = result.data.map((m) => m.id);
    expect(returnedIds).toContain(sourceId);
    expect(returnedIds).toContain(targetId);

    // meta.relationships should contain the overrides relationship
    expect(result.meta.relationships).toBeDefined();
    expect(result.meta.relationships).toHaveLength(1);
    expect(result.meta.relationships![0].type).toBe("overrides");
    expect(result.meta.relationships![0].source_id).toBe(sourceId);
    expect(result.meta.relationships![0].target_id).toBe(targetId);
  });
});

describe("archive soft-deletes relationships", () => {
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

  it("soft-deletes relationships when a memory is archived", async () => {
    // Create two memories
    const sourceResult = await memoryService.create({
      workspace_id: "test-ws",
      content: "archive test source memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(sourceResult.data);
    const sourceId = sourceResult.data.id;

    const targetResult = await memoryService.create({
      workspace_id: "test-ws",
      content: "archive test target memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(targetResult.data);
    const targetId = targetResult.data.id;

    // Create a relationship between them
    await relationshipService.create({
      sourceId,
      targetId,
      type: "overrides",
      userId: "alice",
    });

    // Archive the source memory
    await memoryService.archive(sourceId, "alice");

    // Verify the relationship is soft-deleted: listForMemory on target returns empty
    const rels = await relationshipService.listForMemory(
      targetId,
      "both",
      "alice",
    );
    expect(rels).toHaveLength(0);
  });
});

describe("memory_get includes relationships", () => {
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

  it("returns relationships in memory_get response", async () => {
    // Create two memories
    const sourceResult = await memoryService.create({
      workspace_id: "test-ws",
      content: "source memory for relationship test",
      type: "fact",
      author: "alice",
    });
    assertMemory(sourceResult.data);
    const sourceId = sourceResult.data.id;

    const targetResult = await memoryService.create({
      workspace_id: "test-ws",
      content: "target memory for relationship test",
      type: "fact",
      author: "alice",
    });
    assertMemory(targetResult.data);
    const targetId = targetResult.data.id;

    // Create a relationship between them
    await relationshipService.create({
      sourceId,
      targetId,
      type: "overrides",
      userId: "alice",
    });

    // Fetch via memory_get
    const result = await memoryService.getWithComments(sourceId, "alice");

    expect(result.data.relationships).toHaveLength(1);
    expect(result.data.relationships[0].type).toBe("overrides");
    expect(result.data.relationships[0].direction).toBe("outgoing");
  });
});

describe("end-to-end: create relationship → get → archive → verify cleanup", () => {
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

  it("full lifecycle", async () => {
    // 1. Create two memories: one workspace-scoped, one project-scoped
    const newResult = await memoryService.create({
      workspace_id: "test-ws",
      content: "new authoritative decision about caching strategy",
      type: "decision",
      author: "alice",
      scope: "workspace",
    });
    assertMemory(newResult.data);
    const newId = newResult.data.id;

    const oldResult = await memoryService.create({
      workspace_id: "test-ws",
      content: "old decision about caching strategy",
      type: "decision",
      author: "alice",
      scope: "project",
    });
    assertMemory(oldResult.data);
    const oldId = oldResult.data.id;

    // 2. Create an "overrides" relationship: new memory overrides old
    await relationshipService.create({
      sourceId: newId,
      targetId: oldId,
      type: "overrides",
      description: "New caching decision supersedes old one",
      userId: "alice",
    });

    // 3. Verify memory_get includes the relationship
    const getResult = await memoryService.getWithComments(newId, "alice");
    expect(getResult.data.relationships).toHaveLength(1);
    const rel = getResult.data.relationships[0];
    expect(rel.type).toBe("overrides");
    expect(rel.direction).toBe("outgoing");

    // 4. Verify session_start includes the relationship in meta
    const sessionResult = await memoryService.sessionStart("test-ws", "alice");
    const returnedIds = sessionResult.data.map((m) => m.id);
    expect(returnedIds).toContain(newId);
    expect(returnedIds).toContain(oldId);
    expect(sessionResult.meta.relationships).toBeDefined();
    const sessionRel = sessionResult.meta.relationships!.find(
      (r) => r.source_id === newId && r.target_id === oldId,
    );
    expect(sessionRel).toBeDefined();
    expect(sessionRel!.type).toBe("overrides");

    // 5. Archive the source memory → verify relationship is soft-deleted
    await memoryService.archive(newId, "alice");

    const relsAfterArchive = await relationshipService.listForMemory(
      oldId,
      "both",
      "alice",
    );
    expect(relsAfterArchive).toHaveLength(0);
  });
});
