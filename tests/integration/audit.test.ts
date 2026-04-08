import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  getTestDb,
  truncateAll,
  closeDb,
  assertMemory,
  createTestServiceWithAudit,
} from "../helpers.js";
import { DrizzleAuditRepository } from "../../src/repositories/audit-repository.js";
import { DrizzleWorkspaceRepository } from "../../src/repositories/workspace-repository.js";
import { DrizzleMemoryRepository } from "../../src/repositories/memory-repository.js";
import { MockEmbeddingProvider } from "../../src/providers/embedding/mock.js";
import { config } from "../../src/config.js";
import { generateId } from "../../src/utils/id.js";
import { AuditService } from "../../src/services/audit-service.js";
import { MemoryService } from "../../src/services/memory-service.js";
describe("audit repository", () => {
  let auditRepo: DrizzleAuditRepository;
  let memoryId: string;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    auditRepo = new DrizzleAuditRepository(db);

    // Seed a memory for FK references
    const workspaceRepo = new DrizzleWorkspaceRepository(db);
    await workspaceRepo.findOrCreate("test-ws");
    const memoryRepo = new DrizzleMemoryRepository(db);
    const embedder = new MockEmbeddingProvider(config.embeddingDimensions);
    const embedding = await embedder.embed("test content");
    memoryId = generateId();
    await memoryRepo.create({
      id: memoryId,
      project_id: "test-project",
      workspace_id: "test-ws",
      content: "test content",
      title: "test title",
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
      flag_count: 0,
      relationship_count: 0,
      last_comment_at: null,
      embedding,
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates and retrieves an audit entry", async () => {
    const entry = {
      id: generateId(),
      project_id: "test-project",
      memory_id: memoryId,
      action: "created" as const,
      actor: "alice",
      reason: null,
      diff: null,
      created_at: new Date(),
    };
    await auditRepo.create(entry);

    const entries = await auditRepo.findByMemoryId(memoryId);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("created");
    expect(entries[0].actor).toBe("alice");
  });

  it("returns entries ordered by created_at descending", async () => {
    const entry1 = {
      id: generateId(),
      project_id: "test-project",
      memory_id: memoryId,
      action: "created" as const,
      actor: "alice",
      reason: null,
      diff: null,
      created_at: new Date("2026-01-01"),
    };
    const entry2 = {
      id: generateId(),
      project_id: "test-project",
      memory_id: memoryId,
      action: "updated" as const,
      actor: "bob",
      reason: "fixed typo",
      diff: { before: { content: "old" }, after: { content: "new" } },
      created_at: new Date("2026-01-02"),
    };
    await auditRepo.create(entry1);
    await auditRepo.create(entry2);

    const entries = await auditRepo.findByMemoryId(memoryId);
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("updated");
    expect(entries[1].action).toBe("created");
  });
});

describe("audit service", () => {
  let auditService: AuditService;
  let auditRepo: DrizzleAuditRepository;
  let memoryId: string;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    auditRepo = new DrizzleAuditRepository(db);
    auditService = new AuditService(auditRepo, "test-project");

    // Seed a memory (reuse the same pattern from the existing describe block)
    const workspaceRepo = new DrizzleWorkspaceRepository(db);
    await workspaceRepo.findOrCreate("test-ws");
    const memoryRepo = new DrizzleMemoryRepository(db);
    const embedder = new MockEmbeddingProvider(config.embeddingDimensions);
    const embedding = await embedder.embed("test content");
    memoryId = generateId();
    await memoryRepo.create({
      id: memoryId,
      project_id: "test-project",
      workspace_id: "test-ws",
      content: "test content",
      title: "test title",
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
      flag_count: 0,
      relationship_count: 0,
      last_comment_at: null,
      embedding,
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("logs a create action", async () => {
    await auditService.logCreate(memoryId, "alice");

    const entries = await auditService.getHistory(memoryId);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("created");
    expect(entries[0].actor).toBe("alice");
  });

  it("logs an update action with diff", async () => {
    const diff = {
      before: { content: "old content" },
      after: { content: "new content" },
    };
    await auditService.logUpdate(memoryId, "alice", diff);

    const entries = await auditService.getHistory(memoryId);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("updated");
    expect(entries[0].diff).toEqual(diff);
  });

  it("logs an archive action with reason", async () => {
    await auditService.logArchive(
      memoryId,
      "consolidation",
      "near-exact duplicate",
    );

    const entries = await auditService.getHistory(memoryId);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("archived");
    expect(entries[0].reason).toBe("near-exact duplicate");
  });
});

describe("memory-service audit integration", () => {
  let service: MemoryService;
  let auditRepo: DrizzleAuditRepository;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    auditRepo = new DrizzleAuditRepository(db);
    const auditService = new AuditService(auditRepo, "test-project");
    service = createTestServiceWithAudit(auditService);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("logs audit entry on memory_create", async () => {
    const result = await service.create({
      workspace_id: "test-ws",
      content: "test memory",
      type: "fact",
      author: "alice",
    });
    assertMemory(result.data);

    const entries = await auditRepo.findByMemoryId(result.data.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("created");
  });

  it("logs audit entry on memory_update with diff", async () => {
    const created = await service.create({
      workspace_id: "test-ws",
      content: "original content",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    await service.update(
      created.data.id,
      1,
      { content: "updated content" },
      "alice",
    );

    const entries = await auditRepo.findByMemoryId(created.data.id);
    expect(entries).toHaveLength(2); // created + updated
    const updateEntry = entries.find((e) => e.action === "updated");
    expect(updateEntry).toBeDefined();
    expect(updateEntry!.diff).toHaveProperty("before");
    expect(updateEntry!.diff).toHaveProperty("after");
  });

  it("logs audit entry on memory_archive", async () => {
    const created = await service.create({
      workspace_id: "test-ws",
      content: "will be archived",
      type: "fact",
      author: "alice",
    });
    assertMemory(created.data);

    await service.archive([created.data.id], "alice");

    const entries = await auditRepo.findByMemoryId(created.data.id);
    const archiveEntry = entries.find((e) => e.action === "archived");
    expect(archiveEntry).toBeDefined();
    expect(archiveEntry!.actor).toBe("alice");
  });
});
