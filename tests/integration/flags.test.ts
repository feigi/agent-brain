import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getTestDb, truncateAll, closeDb } from "../helpers.js";
import { DrizzleFlagRepository } from "../../src/repositories/flag-repository.js";
import { DrizzleWorkspaceRepository } from "../../src/repositories/workspace-repository.js";
import { DrizzleMemoryRepository } from "../../src/repositories/memory-repository.js";
import { MockEmbeddingProvider } from "../../src/providers/embedding/mock.js";
import { config } from "../../src/config.js";
import { generateId } from "../../src/utils/id.js";
import type { Flag } from "../../src/types/flag.js";
import { FlagService } from "../../src/services/flag-service.js";
import { DrizzleAuditRepository } from "../../src/repositories/audit-repository.js";
import { AuditService } from "../../src/services/audit-service.js";

async function seedMemory(workspaceId: string): Promise<string> {
  const db = getTestDb();
  const memoryRepo = new DrizzleMemoryRepository(db);
  const embedder = new MockEmbeddingProvider(config.embeddingDimensions);
  const embedding = await embedder.embed("test");
  const id = generateId();
  await memoryRepo.create({
    id,
    project_id: "test-project",
    workspace_id: workspaceId,
    content: "test content",
    title: "test",
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "alice",
    source: "manual",
    session_id: null,
    metadata: null,
    embedding_model: "mock",
    embedding_dimensions: config.embeddingDimensions,
    version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    verified_at: null,
    archived_at: null,
    verified_by: null,
    comment_count: 0,
    last_comment_at: null,
    embedding,
  });
  return id;
}

describe("flag repository", () => {
  let flagRepo: DrizzleFlagRepository;
  let memoryId: string;
  let relatedMemoryId: string;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    flagRepo = new DrizzleFlagRepository(db);
    const workspaceRepo = new DrizzleWorkspaceRepository(db);
    await workspaceRepo.findOrCreate("test-ws");
    memoryId = await seedMemory("test-ws");
    relatedMemoryId = await seedMemory("test-ws");
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates and retrieves a flag", async () => {
    const flag: Flag = {
      id: generateId(),
      project_id: "test-project",
      memory_id: memoryId,
      flag_type: "duplicate",
      severity: "needs_review",
      details: {
        related_memory_id: relatedMemoryId,
        similarity: 0.92,
        reason: "Probable duplicate",
      },
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
    };
    await flagRepo.create(flag);

    const flags = await flagRepo.findByMemoryId(memoryId);
    expect(flags).toHaveLength(1);
    expect(flags[0].flag_type).toBe("duplicate");
  });

  it("findOpenByWorkspace returns only unresolved needs_review flags", async () => {
    const needsReview: Flag = {
      id: generateId(),
      project_id: "test-project",
      memory_id: memoryId,
      flag_type: "contradiction",
      severity: "needs_review",
      details: { reason: "contradicts project memory" },
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
    };
    const autoResolved: Flag = {
      id: generateId(),
      project_id: "test-project",
      memory_id: relatedMemoryId,
      flag_type: "duplicate",
      severity: "auto_resolved",
      details: { reason: "auto-archived" },
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
    };
    await flagRepo.create(needsReview);
    await flagRepo.create(autoResolved);

    const open = await flagRepo.findOpenByWorkspace(
      "test-project",
      "test-ws",
      10,
    );
    expect(open).toHaveLength(1);
    expect(open[0].flag_type).toBe("contradiction");
  });

  it("resolves a flag", async () => {
    const flag: Flag = {
      id: generateId(),
      project_id: "test-project",
      memory_id: memoryId,
      flag_type: "verify",
      severity: "needs_review",
      details: { reason: "stale memory" },
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
    };
    await flagRepo.create(flag);

    const resolved = await flagRepo.resolve(flag.id, "alice", "accepted");
    expect(resolved).toBeDefined();
    expect(resolved!.resolved_at).not.toBeNull();
    expect(resolved!.resolved_by).toBe("alice");

    const open = await flagRepo.findOpenByWorkspace(
      "test-project",
      "test-ws",
      10,
    );
    expect(open).toHaveLength(0);
  });

  it("autoResolveByMemoryId resolves all open flags for a memory", async () => {
    const flag1: Flag = {
      id: generateId(),
      project_id: "test-project",
      memory_id: memoryId,
      flag_type: "duplicate",
      severity: "needs_review",
      details: { reason: "test" },
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
    };
    const flag2: Flag = {
      id: generateId(),
      project_id: "test-project",
      memory_id: memoryId,
      flag_type: "verify",
      severity: "needs_review",
      details: { reason: "test" },
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
    };
    await flagRepo.create(flag1);
    await flagRepo.create(flag2);

    const count = await flagRepo.autoResolveByMemoryId(memoryId);
    expect(count).toBe(2);

    const open = await flagRepo.findOpenByWorkspace(
      "test-project",
      "test-ws",
      10,
    );
    expect(open).toHaveLength(0);
  });
});

describe("flag service", () => {
  let flagService: FlagService;
  let flagRepo: DrizzleFlagRepository;
  let memoryId: string;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    flagRepo = new DrizzleFlagRepository(db);
    const auditRepo = new DrizzleAuditRepository(db);
    const auditService = new AuditService(auditRepo, "test-project");
    flagService = new FlagService(flagRepo, auditService, "test-project");
    const workspaceRepo = new DrizzleWorkspaceRepository(db);
    await workspaceRepo.findOrCreate("test-ws");
    memoryId = await seedMemory("test-ws");
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates a flag and logs to audit", async () => {
    const flag = await flagService.createFlag({
      memoryId,
      flagType: "duplicate",
      severity: "needs_review",
      details: { similarity: 0.92, reason: "probable duplicate" },
    });

    expect(flag.memory_id).toBe(memoryId);
    expect(flag.flag_type).toBe("duplicate");
  });

  it("resolves a flag", async () => {
    const flag = await flagService.createFlag({
      memoryId,
      flagType: "verify",
      severity: "needs_review",
      details: { reason: "stale" },
    });

    const resolved = await flagService.resolveFlag(
      flag.id,
      "alice",
      "dismissed",
    );
    expect(resolved).toBeDefined();
    expect(resolved!.resolved_at).not.toBeNull();
  });

  it("gets open flags for workspace", async () => {
    await flagService.createFlag({
      memoryId,
      flagType: "contradiction",
      severity: "needs_review",
      details: { reason: "test" },
    });

    const open = await flagService.getOpenFlags("test-ws", 5);
    expect(open).toHaveLength(1);
  });

  it("throws NotFoundError for non-existent flag", async () => {
    await expect(
      flagService.resolveFlag("nonexistent", "alice", "accepted"),
    ).rejects.toThrow("not found");
  });
});
