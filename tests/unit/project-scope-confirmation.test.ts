import { describe, it, expect, vi } from "vitest";
import { MemoryService } from "../../src/services/memory-service.js";
import { AuditService } from "../../src/services/audit-service.js";
import type { Memory } from "../../src/types/memory.js";
import type {
  MemoryRepository,
  WorkspaceRepository,
  AuditRepository,
} from "../../src/repositories/types.js";
import type { EmbeddingProvider } from "../../src/providers/embedding/types.js";

const MOCK_EMBEDDING = new Array(768).fill(0);

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date();
  return {
    id: "mem-proj-001",
    project_id: "test-project",
    workspace_id: null,
    content: "Test memory content",
    title: "Test memory",
    type: "fact",
    scope: "project",
    tags: null,
    author: "alice",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: "mock",
    embedding_dimensions: 768,
    version: 1,
    created_at: now,
    updated_at: now,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    ...overrides,
  };
}

function makeMemoryRepo(): MemoryRepository {
  return {
    create: vi.fn().mockImplementation(async (input) => makeMemory(input)),
    findById: vi.fn().mockResolvedValue(null),
    findByIdIncludingArchived: vi.fn().mockResolvedValue(null),
    findByIds: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    archive: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    list: vi.fn(),
    findStale: vi.fn(),
    listRecentWorkspaceAndUser: vi.fn().mockResolvedValue([]),
    listProjectScoped: vi.fn().mockResolvedValue([]),
    verify: vi.fn(),
    findRecentActivity: vi.fn().mockResolvedValue([]),
    countTeamActivity: vi.fn().mockResolvedValue({
      new_memories: 0,
      updated_memories: 0,
      commented_memories: 0,
    }),
    findDuplicates: vi.fn().mockResolvedValue([]),
    findPairwiseSimilar: vi.fn().mockResolvedValue([]),
    listDistinctWorkspaces: vi.fn().mockResolvedValue([]),
    listWithEmbeddings: vi.fn().mockResolvedValue([]),
  } as MemoryRepository;
}

function makeWorkspaceRepo(): WorkspaceRepository {
  return {
    findOrCreate: vi
      .fn()
      .mockResolvedValue({ id: "test-project", created_at: new Date() }),
    findById: vi.fn().mockResolvedValue(null),
  };
}

function makeEmbedder(): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(MOCK_EMBEDDING),
    modelName: "mock",
    dimensions: 768,
  };
}

function makeAuditRepo(): AuditRepository {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    findByMemoryId: vi.fn().mockResolvedValue([]),
  } as AuditRepository;
}

function makeService(
  opts: {
    memoryRepo?: MemoryRepository;
    auditRepo?: AuditRepository;
  } = {},
): {
  service: MemoryService;
  memoryRepo: MemoryRepository;
  auditRepo: AuditRepository;
} {
  const memoryRepo = opts.memoryRepo ?? makeMemoryRepo();
  const workspaceRepo = makeWorkspaceRepo();
  const embedder = makeEmbedder();
  const auditRepo = opts.auditRepo ?? makeAuditRepo();
  const auditService = new AuditService(auditRepo, "test-project");
  const service = new MemoryService(
    memoryRepo,
    workspaceRepo,
    embedder,
    "test-project",
    undefined,
    undefined,
    undefined,
    auditService,
  );
  return { service, memoryRepo, auditRepo };
}

describe("Project-scope confirmation (issue #21)", () => {
  describe("workspace_id silent coercion on project scope", () => {
    it("accepts workspace_id with scope=project and coerces it to null", async () => {
      const { service, memoryRepo } = makeService();

      const result = await service.create({
        workspace_id: "ignored-workspace",
        content: "Cross-workspace decision",
        type: "decision",
        scope: "project",
        author: "alice",
        source: "manual",
      });

      expect("skipped" in result.data).toBe(false);
      expect(memoryRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "project",
          workspace_id: null,
        }),
      );
    });
  });
});
