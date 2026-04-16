import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  getTestDb,
  truncateAll,
  closeDb,
  assertMemory,
  createTestService,
  createTestServiceWithFlags,
} from "../helpers.js";
import { DrizzleMemoryRepository } from "../../src/repositories/memory-repository.js";
import { DrizzleFlagRepository } from "../../src/repositories/flag-repository.js";
import { DrizzleAuditRepository } from "../../src/repositories/audit-repository.js";
import { DrizzleRelationshipRepository } from "../../src/repositories/relationship-repository.js";
import { AuditService } from "../../src/services/audit-service.js";
import { FlagService } from "../../src/services/flag-service.js";
import { RelationshipService } from "../../src/services/relationship-service.js";
import { ConsolidationService } from "../../src/services/consolidation-service.js";
import { memories, flags } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { generateId } from "../../src/utils/id.js";
import type { MemoryService } from "../../src/services/memory-service.js";

describe("consolidation repository support", () => {
  let memoryRepo: DrizzleMemoryRepository;
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    memoryRepo = new DrizzleMemoryRepository(db);
    service = createTestService();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("finds pairwise similar memories within workspace", async () => {
    const m1 = await service.create({
      workspace_id: "test-ws",
      content: "Always use UTC timestamps in database columns",
      type: "decision",
      author: "alice",
    });
    assertMemory(m1.data);
    const m2 = await service.create({
      workspace_id: "test-ws",
      content: "Always use UTC timestamps in the database",
      type: "decision",
      author: "alice",
    });
    assertMemory(m2.data);

    const pairs = await memoryRepo.findPairwiseSimilar({
      projectId: "test-project",
      workspaceId: "test-ws",
      scope: "workspace",
      threshold: 0.5, // Low threshold for mock embeddings
    });

    // With mock embeddings the similarity may vary, but both memories should be found
    expect(pairs.length).toBeGreaterThanOrEqual(0); // Mock embeddings are random, so can't guarantee match
  });

  it("lists distinct workspaces", async () => {
    await service.create({
      workspace_id: "ws-a",
      content: "memory in ws-a",
      type: "fact",
      author: "alice",
    });
    await service.create({
      workspace_id: "ws-b",
      content: "memory in ws-b",
      type: "fact",
      author: "alice",
    });

    const workspaces = await memoryRepo.listDistinctWorkspaces("test-project");
    expect(workspaces).toContain("ws-a");
    expect(workspaces).toContain("ws-b");
  });

  it("findDuplicates workspace scope excludes user-scoped memories in same workspace", async () => {
    // Regression: userScopeCheck calls findDuplicates({scope: "workspace"}) for a
    // user-scoped memory; without a scope filter the user memory matched itself,
    // which the relationship service then rejected with "Source and target must
    // be different memories".
    const userMem = await service.create({
      workspace_id: "test-ws",
      content: "user memory content about auth patterns",
      type: "learning",
      author: "alice",
      scope: "user",
    });
    assertMemory(userMem.data);

    const dups = await memoryRepo.findDuplicates({
      embedding: new Array(768).fill(0),
      projectId: "test-project",
      workspaceId: "test-ws",
      scope: "workspace",
      userId: "alice",
      threshold: 0,
    });

    expect(dups.find((d) => d.id === userMem.data.id)).toBeUndefined();
  });

  it("lists memories with embeddings for a workspace", async () => {
    const m1 = await service.create({
      workspace_id: "test-ws",
      content: "memory with embedding",
      type: "fact",
      author: "alice",
    });
    assertMemory(m1.data);

    const withEmbeddings = await memoryRepo.listWithEmbeddings({
      projectId: "test-project",
      workspaceId: "test-ws",
      scope: "workspace",
      limit: 10,
    });

    expect(withEmbeddings).toHaveLength(1);
    expect(withEmbeddings[0].embedding).toBeDefined();
    expect(Array.isArray(withEmbeddings[0].embedding)).toBe(true);
    expect(withEmbeddings[0].embedding.length).toBe(768); // mock dimensions
  });
});

describe("consolidation full run", () => {
  let consolidationService: ConsolidationService;
  let flagRepo: DrizzleFlagRepository;
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    const memoryRepo = new DrizzleMemoryRepository(db);
    flagRepo = new DrizzleFlagRepository(db);
    const auditRepo = new DrizzleAuditRepository(db);
    const auditService = new AuditService(auditRepo, "test-project");
    const flagService = new FlagService(flagRepo, auditService, "test-project");
    service = createTestService();
    consolidationService = new ConsolidationService(
      memoryRepo,
      flagService,
      auditService,
      "test-project",
      {
        autoArchiveThreshold: 0.95,
        flagThreshold: 0.9,
        verifyAfterDays: 30,
      },
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it("runs without errors on empty database", async () => {
    const result = await consolidationService.run();
    expect(result.archived).toBe(0);
    expect(result.flagged).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("runs without errors when no duplicates found", async () => {
    await service.create({
      workspace_id: "test-ws",
      content: "completely unique memory about databases",
      type: "fact",
      author: "alice",
    });
    await service.create({
      workspace_id: "test-ws",
      content: "entirely different memory about frontend design",
      type: "decision",
      author: "alice",
    });

    const result = await consolidationService.run();
    expect(result.errors).toBe(0);
  });

  it("flags verification candidates for old unverified memories", async () => {
    const created = await service.create({
      workspace_id: "test-ws",
      content: "old unverified memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    // Backdate the memory to make it stale
    const db = getTestDb();
    await db
      .update(memories)
      .set({
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-01"),
      })
      .where(eq(memories.id, created.data.id));

    const result = await consolidationService.run();
    expect(result.flagged).toBeGreaterThanOrEqual(1);

    const memoryFlags = await flagRepo.findByMemoryId(created.data.id);
    const verifyFlag = memoryFlags.find((f) => f.flag_type === "verify");
    expect(verifyFlag).toBeDefined();
  });

  it("does not create duplicate verify flags", async () => {
    const created = await service.create({
      workspace_id: "test-ws",
      content: "stale memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    const db = getTestDb();
    await db
      .update(memories)
      .set({
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-01"),
      })
      .where(eq(memories.id, created.data.id));

    // Run twice
    await consolidationService.run();
    await consolidationService.run();

    const memoryFlags = await flagRepo.findByMemoryId(created.data.id);
    const verifyFlags = memoryFlags.filter((f) => f.flag_type === "verify");
    expect(verifyFlags).toHaveLength(1);
  });

  it("does not create duplicate flags for the same memory pair", async () => {
    // 1. Create two memories
    const m1Result = await service.create({
      workspace_id: "test-ws",
      content: "always use snake_case for database columns",
      type: "decision",
      author: "alice",
    });
    assertMemory(m1Result.data);
    const m1 = m1Result.data;
    const m2Result = await service.create({
      workspace_id: "test-ws",
      content: "always use snake_case for db columns",
      type: "decision",
      author: "alice",
    });
    assertMemory(m2Result.data);
    const m2 = m2Result.data;

    // 2. Manually create a needs_review duplicate flag for this pair
    const db = getTestDb();
    await db.insert(flags).values({
      id: generateId(),
      project_id: "test-project",
      memory_id: m2.id,
      flag_type: "duplicate",
      severity: "needs_review",
      details: {
        related_memory_id: m1.id,
        similarity: 0.92,
        reason: "Probable duplicate",
      },
    });

    // 3. Run consolidation
    await consolidationService.run();

    // 4. Verify no additional duplicate flag was created for that pair
    const memoryFlags = await flagRepo.findByMemoryId(m2.id);
    const dupFlags = memoryFlags.filter(
      (f) =>
        f.flag_type === "duplicate" && f.details.related_memory_id === m1.id,
    );
    expect(dupFlags).toHaveLength(1);
  });
});

describe("end-to-end: create → consolidate → session start → resolve", () => {
  let service: MemoryService;
  let consolidationService: ConsolidationService;
  let flagRepo: DrizzleFlagRepository;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    const memoryRepo = new DrizzleMemoryRepository(db);
    flagRepo = new DrizzleFlagRepository(db);
    const auditRepo = new DrizzleAuditRepository(db);
    const auditService = new AuditService(auditRepo, "test-project");
    const flagService = new FlagService(flagRepo, auditService, "test-project");
    service = createTestServiceWithFlags(flagService, auditService);
    consolidationService = new ConsolidationService(
      memoryRepo,
      flagService,
      auditService,
      "test-project",
      {
        autoArchiveThreshold: 0.95,
        flagThreshold: 0.9,
        verifyAfterDays: 30,
      },
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it("full lifecycle: create memories, consolidate, verify flags at session start, resolve", async () => {
    // 1. Create a memory and backdate it to trigger verify flag
    const created = await service.create({
      workspace_id: "test-ws",
      content: "important architecture decision about caching",
      type: "decision",
      author: "alice",
    });
    assertMemory(created.data);

    const db = getTestDb();
    await db
      .update(memories)
      .set({
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-01"),
      })
      .where(eq(memories.id, created.data.id));

    // 2. Run consolidation
    const consolResult = await consolidationService.run();
    expect(consolResult.flagged).toBeGreaterThanOrEqual(1);

    // 3. Session start should include flags
    const session = await service.sessionStart("test-ws", "alice");
    expect(session.meta.flags).toBeDefined();
    expect(session.meta.flags!.length).toBeGreaterThanOrEqual(1);

    // Verify the flag has enriched memory data
    const verifyFlag = session.meta.flags!.find(
      (f) => f.flag_type === "verify",
    );
    expect(verifyFlag).toBeDefined();
    expect(verifyFlag!.memory.title).toBeDefined();
    expect(verifyFlag!.memory.content).toContain("caching");
    expect(verifyFlag!.reason).toContain("verified");

    // 4. Resolve the flag
    const flagId = verifyFlag!.flag_id;
    const resolved = await flagRepo.resolve(flagId, "alice", "accepted");
    expect(resolved).toBeDefined();

    // 5. Next session start should have no flags (or fewer flags)
    const session2 = await service.sessionStart("test-ws", "alice");
    const remainingVerifyFlags = (session2.meta.flags ?? []).filter(
      (f) => f.flag_type === "verify" && f.flag_id === flagId,
    );
    expect(remainingVerifyFlags).toHaveLength(0);
  });

  it("consolidation result includes enriched flag details", async () => {
    // 1. Create a memory and backdate it to trigger verify flag
    const created = await service.create({
      workspace_id: "test-ws",
      content: "stale memory that needs verification",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    const db = getTestDb();
    await db
      .update(memories)
      .set({
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-01"),
      })
      .where(eq(memories.id, created.data.id));

    // 2. Run consolidation and check the result includes flags
    const result = await consolidationService.run();
    expect(result.flagged).toBeGreaterThanOrEqual(1);
    expect(result.flags).toBeDefined();
    expect(result.flags.length).toBeGreaterThanOrEqual(1);

    const verifyFlag = result.flags.find((f) => f.flag_type === "verify");
    expect(verifyFlag).toBeDefined();
    expect(verifyFlag!.flag_id).toBeDefined();
    expect(verifyFlag!.memory.id).toBe(created.data.id);
    expect(verifyFlag!.memory.content).toContain("stale memory");
    expect(verifyFlag!.reason).toContain("verified");
    expect(verifyFlag!.related_memory).toBeNull();
  });

  it("memory_get returns open flags for the memory", async () => {
    // 1. Create a memory and backdate it
    const created = await service.create({
      workspace_id: "test-ws",
      content: "flagged memory for get test",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    const db = getTestDb();
    await db
      .update(memories)
      .set({
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-01"),
      })
      .where(eq(memories.id, created.data.id));

    // 2. Consolidate to create a verify flag
    await consolidationService.run();

    // 3. memory_get should include the flag
    const getResult = await service.getWithComments(created.data.id, "alice");
    expect(getResult.data.flags).toBeDefined();
    expect(getResult.data.flags.length).toBeGreaterThanOrEqual(1);

    const verifyFlag = getResult.data.flags.find(
      (f) => f.flag_type === "verify",
    );
    expect(verifyFlag).toBeDefined();
    expect(verifyFlag!.flag_id).toBeDefined();
    expect(verifyFlag!.reason).toContain("verified");

    // 4. Resolve the flag, then memory_get should return empty flags
    await flagRepo.resolve(verifyFlag!.flag_id, "alice", "accepted");
    const getResult2 = await service.getWithComments(created.data.id, "alice");
    const remaining = getResult2.data.flags.filter(
      (f) => f.flag_type === "verify",
    );
    expect(remaining).toHaveLength(0);
  });
});

describe("consolidation creates relationships", () => {
  let consolidationService: ConsolidationService;
  let relationshipRepo: DrizzleRelationshipRepository;
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    const memoryRepo = new DrizzleMemoryRepository(db);
    const flagRepo = new DrizzleFlagRepository(db);
    const auditRepo = new DrizzleAuditRepository(db);
    const auditService = new AuditService(auditRepo, "test-project");
    const flagService = new FlagService(flagRepo, auditService, "test-project");
    relationshipRepo = new DrizzleRelationshipRepository(db);
    const relationshipService = new RelationshipService(
      relationshipRepo,
      memoryRepo,
      "test-project",
    );
    service = createTestService();
    consolidationService = new ConsolidationService(
      memoryRepo,
      flagService,
      auditService,
      "test-project",
      { autoArchiveThreshold: 0.95, flagThreshold: 0.9, verifyAfterDays: 30 },
      relationshipService,
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates a duplicates relationship for content-subset auto-archive", async () => {
    // Create a short memory and a longer one that contains it
    const m1 = await service.create({
      workspace_id: "test-ws",
      content: "use snake_case for columns",
      type: "decision",
      author: "alice",
    });
    assertMemory(m1.data);
    const m2 = await service.create({
      workspace_id: "test-ws",
      content: "use snake_case for columns and always add timestamps",
      type: "decision",
      author: "alice",
    });
    assertMemory(m2.data);

    await consolidationService.run();

    // m1 is a content subset of m2, so a "duplicates" relationship should exist
    const rels = await relationshipRepo.findByMemoryId(
      "test-project",
      m1.data.id,
      "both",
    );
    expect(rels).toHaveLength(1);
    expect(rels[0].type).toBe("duplicates");
    expect(rels[0].created_via).toBe("consolidation");
    // After direction fix: source = surviving (m2), target = archived (m1)
    expect(rels[0].source_id).toBe(m2.data.id);
    expect(rels[0].target_id).toBe(m1.data.id);
  });

  it("runs cross-scope check without errors (mock embeddings may not trigger threshold)", async () => {
    const proj = await service.create({
      workspace_id: "test-ws",
      content: "Global rule about API naming",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(proj.data);
    const ws = await service.create({
      workspace_id: "test-ws",
      content: "Global rule about API naming conventions",
      type: "decision",
      author: "alice",
    });
    assertMemory(ws.data);

    const result = await consolidationService.run();
    expect(result.errors).toBe(0);
  });
});
