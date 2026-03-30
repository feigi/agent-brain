import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryService } from "../../src/services/memory-service.js";
import type { Memory } from "../../src/types/memory.js";
import type {
  MemoryRepository,
  ProjectRepository,
} from "../../src/repositories/types.js";
import type { EmbeddingProvider } from "../../src/providers/embedding/types.js";

const MOCK_EMBEDDING = new Array(768).fill(0);

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date();
  return {
    id: "mem-001",
    project_id: "test-project",
    content: "Test content",
    title: "Test title",
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "alice",
    source: "manual",
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
    last_comment_at: null,
    verified_by: null,
    ...overrides,
  };
}

function makeMemoryRepo(
  overrides: Partial<MemoryRepository> = {},
): MemoryRepository {
  return {
    create: vi.fn().mockResolvedValue(makeMemory()),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    archive: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    list: vi.fn(),
    findStale: vi.fn(),
    listRecentBothScopes: vi.fn().mockResolvedValue([]),
    verify: vi.fn(),
    findRecentActivity: vi.fn().mockResolvedValue([]),
    countTeamActivity: vi.fn().mockResolvedValue({
      new_memories: 0,
      updated_memories: 0,
      commented_memories: 0,
    }),
    findDuplicates: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as MemoryRepository;
}

function makeProjectRepo(): ProjectRepository {
  return {
    findOrCreate: vi
      .fn()
      .mockResolvedValue({ id: "test-project", created_at: new Date() }),
    findById: vi.fn().mockResolvedValue(null),
  };
}

function makeEmbeddingProvider(): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(MOCK_EMBEDDING),
    modelName: "mock",
    dimensions: 768,
  };
}

describe("Duplicate detection in memory_create", () => {
  let projectRepo: ProjectRepository;
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    projectRepo = makeProjectRepo();
    embedder = makeEmbeddingProvider();
  });

  it("create is soft-rejected when duplicate found", async () => {
    const memoryRepo = makeMemoryRepo({
      findDuplicates: vi.fn().mockResolvedValue([
        {
          id: "existing-1",
          title: "Existing Memory",
          relevance: 0.95,
          scope: "workspace",
        },
      ]),
    });
    const service = new MemoryService(memoryRepo, projectRepo, embedder);

    const result = await service.create({
      project_id: "test-project",
      content: "Content that is very similar to existing",
      type: "fact",
      author: "alice",
    });

    expect("skipped" in result.data && result.data.skipped).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("duplicate");
      expect(result.data.duplicate?.id).toBe("existing-1");
    }
    // Should NOT create a new memory
    expect(memoryRepo.create).not.toHaveBeenCalled();
  });

  it("create succeeds when no duplicate found", async () => {
    // findDuplicates returns empty array (no duplicates)
    const memoryRepo = makeMemoryRepo({
      findDuplicates: vi.fn().mockResolvedValue([]),
    });
    const service = new MemoryService(memoryRepo, projectRepo, embedder);

    const result = await service.create({
      project_id: "test-project",
      content: "Completely unique content that has no match",
      type: "fact",
      author: "alice",
    });

    expect(result.data).toHaveProperty("id");
    expect("skipped" in result.data).toBe(false);
    expect(memoryRepo.create).toHaveBeenCalled();
  });

  it("duplicate detection runs on manual writes too (D-14)", async () => {
    // D-14: Dedup applies to ALL writes, including manual writes
    const memoryRepo = makeMemoryRepo({
      findDuplicates: vi.fn().mockResolvedValue([
        {
          id: "proj-existing",
          title: "Project Memory",
          relevance: 0.92,
          scope: "workspace",
        },
      ]),
    });
    const service = new MemoryService(memoryRepo, projectRepo, embedder);

    const result = await service.create({
      project_id: "test-project",
      content: "Manual write that matches an existing memory",
      type: "fact",
      author: "alice",
      source: "manual", // manual writes are also subject to dedup
    });

    expect("skipped" in result.data && result.data.skipped).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("duplicate");
    }
  });

  it("cross-scope duplicate message for user memory matching project scope (D-16)", async () => {
    // A user-scoped memory matching a project-scoped memory should get the 'shared knowledge' message
    const memoryRepo = makeMemoryRepo({
      findDuplicates: vi.fn().mockResolvedValue([
        {
          id: "proj-1",
          title: "Project Memory",
          relevance: 0.92,
          scope: "workspace",
        },
      ]),
    });
    const service = new MemoryService(memoryRepo, projectRepo, embedder);

    // Trying to create a user-scoped memory
    const result = await service.create({
      project_id: "test-project",
      content: "User memory that duplicates project scope",
      type: "fact",
      author: "alice",
      scope: "user", // user scope, but duplicate found in project scope
    });

    expect("skipped" in result.data && result.data.skipped).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("duplicate");
      expect(result.data.message).toContain("shared knowledge");
    }
  });

  it("same-scope duplicate message mentions the existing memory id and similarity", async () => {
    const memoryRepo = makeMemoryRepo({
      findDuplicates: vi.fn().mockResolvedValue([
        {
          id: "existing-99",
          title: "Existing Project Memory",
          relevance: 0.97,
          scope: "workspace",
        },
      ]),
    });
    const service = new MemoryService(memoryRepo, projectRepo, embedder);

    const result = await service.create({
      project_id: "test-project",
      content: "Project memory that duplicates another project memory",
      type: "fact",
      author: "alice",
      scope: "workspace",
    });

    expect("skipped" in result.data && result.data.skipped).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("duplicate");
      // Same-scope message should reference the memory id and similarity
      expect(result.data.message).toContain("existing-99");
      expect(result.data.message).toContain("97%");
    }
  });

  it("duplicate response includes existing memory info (id, title, relevance)", async () => {
    const memoryRepo = makeMemoryRepo({
      findDuplicates: vi.fn().mockResolvedValue([
        {
          id: "dup-id",
          title: "Dup Title",
          relevance: 0.93,
          scope: "workspace",
        },
      ]),
    });
    const service = new MemoryService(memoryRepo, projectRepo, embedder);

    const result = await service.create({
      project_id: "test-project",
      content: "Some content",
      type: "fact",
      author: "alice",
    });

    if ("skipped" in result.data && result.data.skipped) {
      expect(result.data.duplicate).toBeDefined();
      expect(result.data.duplicate?.id).toBe("dup-id");
      expect(result.data.duplicate?.title).toBe("Dup Title");
      expect(result.data.duplicate?.relevance).toBe(0.93);
    }
  });

  it("findDuplicates is called with correct embedding and scope parameters", async () => {
    const findDuplicates = vi.fn().mockResolvedValue([]);
    const memoryRepo = makeMemoryRepo({ findDuplicates });
    const service = new MemoryService(memoryRepo, projectRepo, embedder);

    await service.create({
      project_id: "my-project",
      content: "Some content for scope check",
      type: "fact",
      author: "bob",
      scope: "user",
    });

    expect(findDuplicates).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "my-project",
        scope: "user",
        userId: "bob",
      }),
    );
  });
});
