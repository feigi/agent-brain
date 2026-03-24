import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryService } from "../../src/services/memory-service.js";
import { ValidationError } from "../../src/utils/errors.js";
import type { Memory } from "../../src/types/memory.js";
import type {
  MemoryRepository,
  ProjectRepository,
  SessionRepository,
} from "../../src/repositories/types.js";
import type { EmbeddingProvider } from "../../src/providers/embedding/types.js";

// 512-dim zero vector (deterministic for all tests)
const MOCK_EMBEDDING = new Array(512).fill(0);

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date();
  return {
    id: "mem-test-001",
    project_id: "test-project",
    content: "Test memory content",
    title: "Test memory",
    type: "fact",
    scope: "project",
    tags: null,
    author: "alice",
    source: "agent-auto",
    session_id: "test-session",
    metadata: null,
    embedding_model: "mock",
    embedding_dimensions: 512,
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
    // findDuplicates returns empty array by default (no duplicates)
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
    dimensions: 512,
  };
}

function makeSessionLifecycleRepo(
  overrides: Partial<SessionRepository> = {},
): SessionRepository {
  return {
    createSession: vi.fn().mockResolvedValue(undefined),
    getBudget: vi.fn().mockResolvedValue({ used: 5, limit: 10 }),
    incrementBudgetUsed: vi
      .fn()
      .mockResolvedValue({ used: 6, exceeded: false }),
    findById: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("Budget enforcement in memory_create", () => {
  let memoryRepo: MemoryRepository;
  let projectRepo: ProjectRepository;
  let embedder: EmbeddingProvider;
  let sessionLifecycleRepo: SessionRepository;

  beforeEach(() => {
    memoryRepo = makeMemoryRepo();
    projectRepo = makeProjectRepo();
    embedder = makeEmbeddingProvider();
    sessionLifecycleRepo = makeSessionLifecycleRepo();
  });

  it("autonomous write with source agent-auto succeeds when under budget", async () => {
    // getBudget returns used=5, limit=10 (under budget)
    const service = new MemoryService(
      memoryRepo,
      projectRepo,
      embedder,
      undefined,
      undefined,
      sessionLifecycleRepo,
    );

    const result = await service.create({
      project_id: "test-project",
      content: "Important insight about database queries",
      type: "fact",
      author: "alice",
      source: "agent-auto",
      session_id: "test-session",
    });

    expect(result.data).toHaveProperty("id");
    expect("skipped" in result.data).toBe(false);
    expect(sessionLifecycleRepo.getBudget).toHaveBeenCalledWith("test-session");
    expect(sessionLifecycleRepo.incrementBudgetUsed).toHaveBeenCalled();
  });

  it("autonomous write with source session-review succeeds when under budget", async () => {
    const service = new MemoryService(
      memoryRepo,
      projectRepo,
      embedder,
      undefined,
      undefined,
      sessionLifecycleRepo,
    );

    const result = await service.create({
      project_id: "test-project",
      content: "Session learnings about test patterns",
      type: "learning",
      author: "alice",
      source: "session-review",
      session_id: "test-session",
    });

    expect(result.data).toHaveProperty("id");
    expect("skipped" in result.data).toBe(false);
    expect(sessionLifecycleRepo.getBudget).toHaveBeenCalledWith("test-session");
  });

  it("autonomous write is soft-rejected when budget exceeded", async () => {
    // getBudget returns used=10, limit=10 (at limit)
    sessionLifecycleRepo = makeSessionLifecycleRepo({
      getBudget: vi.fn().mockResolvedValue({ used: 10, limit: 10 }),
    });
    const service = new MemoryService(
      memoryRepo,
      projectRepo,
      embedder,
      undefined,
      undefined,
      sessionLifecycleRepo,
    );

    const result = await service.create({
      project_id: "test-project",
      content: "This should be soft-rejected",
      type: "fact",
      author: "alice",
      source: "agent-auto",
      session_id: "test-session",
    });

    expect("skipped" in result.data && result.data.skipped).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("budget_exceeded");
    }
    expect(result.meta.budget?.exceeded).toBe(true);
    // Should NOT call incrementBudgetUsed when budget already exceeded
    expect(sessionLifecycleRepo.incrementBudgetUsed).not.toHaveBeenCalled();
    // Should NOT call memoryRepo.create
    expect(memoryRepo.create).not.toHaveBeenCalled();
  });

  it("manual write bypasses budget check", async () => {
    // getBudget should never be called for manual writes
    sessionLifecycleRepo = makeSessionLifecycleRepo({
      getBudget: vi
        .fn()
        .mockRejectedValue(
          new Error("getBudget should not be called for manual writes"),
        ),
    });
    const service = new MemoryService(
      memoryRepo,
      projectRepo,
      embedder,
      undefined,
      undefined,
      sessionLifecycleRepo,
    );

    const result = await service.create({
      project_id: "test-project",
      content: "Manually saved important context",
      type: "fact",
      author: "alice",
      source: "manual",
      // no session_id needed for manual writes
    });

    expect(result.data).toHaveProperty("id");
    expect("skipped" in result.data).toBe(false);
    // getBudget must NOT have been called
    expect(sessionLifecycleRepo.getBudget).not.toHaveBeenCalled();
  });

  it("autonomous write without session_id throws ValidationError", async () => {
    const service = new MemoryService(
      memoryRepo,
      projectRepo,
      embedder,
      undefined,
      undefined,
      sessionLifecycleRepo,
    );

    await expect(
      service.create({
        project_id: "test-project",
        content: "This should throw because no session_id",
        type: "fact",
        author: "alice",
        source: "agent-auto",
        // no session_id
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      service.create({
        project_id: "test-project",
        content: "This should throw because no session_id",
        type: "fact",
        author: "alice",
        source: "agent-auto",
      }),
    ).rejects.toThrow("session_id is required");
  });

  it("manual write without session_id succeeds", async () => {
    const service = new MemoryService(
      memoryRepo,
      projectRepo,
      embedder,
      undefined,
      undefined,
      sessionLifecycleRepo,
    );

    const result = await service.create({
      project_id: "test-project",
      content: "Manual write with no session_id is fine",
      type: "fact",
      author: "alice",
      source: "manual",
      // intentionally no session_id
    });

    expect(result.data).toHaveProperty("id");
    expect("skipped" in result.data).toBe(false);
  });

  it("budget meta is included in response after successful autonomous write", async () => {
    // incrementBudgetUsed returns used=6
    sessionLifecycleRepo = makeSessionLifecycleRepo({
      getBudget: vi.fn().mockResolvedValue({ used: 5, limit: 10 }),
      incrementBudgetUsed: vi
        .fn()
        .mockResolvedValue({ used: 6, exceeded: false }),
    });
    const service = new MemoryService(
      memoryRepo,
      projectRepo,
      embedder,
      undefined,
      undefined,
      sessionLifecycleRepo,
    );

    const result = await service.create({
      project_id: "test-project",
      content: "Successful autonomous write",
      type: "fact",
      author: "alice",
      source: "agent-auto",
      session_id: "test-session",
    });

    expect(result.meta.budget).toBeDefined();
    expect(result.meta.budget?.used).toBe(6);
    expect(result.meta.budget?.limit).toBeGreaterThan(0);
    expect(result.meta.budget?.exceeded).toBe(false);
  });
});
