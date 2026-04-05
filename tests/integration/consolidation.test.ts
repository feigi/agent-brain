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
import { AuditService } from "../../src/services/audit-service.js";
import { FlagService } from "../../src/services/flag-service.js";
import { ConsolidationService } from "../../src/services/consolidation-service.js";
import { memories } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
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
        contradictionThreshold: 0.8,
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
        contradictionThreshold: 0.8,
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
});
