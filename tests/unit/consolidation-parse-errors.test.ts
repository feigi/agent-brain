import { describe, it, expect, vi } from "vitest";
import {
  ConsolidationService,
  type ParseErrorChecker,
} from "../../src/services/consolidation-service.js";
import type { MemoryRepository } from "../../src/repositories/types.js";
import type { FlagService } from "../../src/services/flag-service.js";
import type { AuditService } from "../../src/services/audit-service.js";
import type { Memory } from "../../src/types/memory.js";
import type { Flag } from "../../src/types/flag.js";

const config = {
  autoArchiveThreshold: 0.95,
  flagThreshold: 0.9,
  verifyAfterDays: 30,
};

function stubMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date("2026-01-01");
  return {
    id: "mem-1",
    project_id: "proj-1",
    workspace_id: "ws-1",
    content: "body",
    title: "Memory One",
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "alice",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: null,
    embedding_dimensions: null,
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

function stubFlag(overrides: Partial<Flag> = {}): Flag {
  return {
    id: "flag-new",
    project_id: "proj-1",
    memory_id: "mem-1",
    flag_type: "parse_error",
    severity: "needs_review",
    details: { reason: "Parse error in x.md: boom" },
    resolved_at: null,
    resolved_by: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeDeps(): {
  memoryRepo: MemoryRepository;
  flagService: FlagService;
  auditService: AuditService;
  findById: ReturnType<typeof vi.fn>;
  createFlag: ReturnType<typeof vi.fn>;
  resolveFlag: ReturnType<typeof vi.fn>;
} {
  const findById = vi.fn();
  const createFlag = vi.fn();
  const resolveFlag = vi.fn();

  const memoryRepo = {
    findByIdIncludingArchived: findById,
    // listDistinctWorkspaces returns empty so Layer 2 is a no-op.
    listDistinctWorkspaces: vi.fn().mockResolvedValue([]),
    // Layer 1 (project scope) — no memories.
    list: vi.fn().mockResolvedValue({ memories: [], cursor: null }),
    findPairwiseSimilar: vi.fn().mockResolvedValue([]),
    archive: vi.fn(),
  } as unknown as MemoryRepository;

  const flagService = {
    createFlag,
    resolveFlag,
    hasOpenFlag: vi.fn().mockResolvedValue(false),
    getFlagsByMemoryId: vi.fn().mockResolvedValue([]),
    autoResolveByMemoryId: vi.fn(),
    getOpenFlags: vi.fn(),
    findByMemoryIds: vi.fn(),
  } as unknown as FlagService;

  const auditService = {
    logArchive: vi.fn(),
  } as unknown as AuditService;

  return {
    memoryRepo,
    flagService,
    auditService,
    findById,
    createFlag,
    resolveFlag,
  };
}

describe("ConsolidationService.checkParseErrors (Layer 4)", () => {
  it("creates a parse_error flag with real memory fields loaded from the repo", async () => {
    const deps = makeDeps();
    deps.findById.mockResolvedValue(
      stubMemory({ title: "Real Title", content: "real content" }),
    );
    deps.createFlag.mockResolvedValue(stubFlag({ id: "flag-123" }));

    const checker: ParseErrorChecker = {
      check: async () => ({
        errors: [
          {
            memoryId: "mem-1",
            path: "workspaces/ws-1/memories/x.md",
            reason: "boom",
          },
        ],
        resolvable: [],
      }),
    };

    const svc = new ConsolidationService(
      deps.memoryRepo,
      deps.flagService,
      deps.auditService,
      "proj-1",
      config,
      undefined,
      undefined,
      checker,
    );

    const result = await svc.run();

    expect(result.flagged).toBe(1);
    expect(result.resolved).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.flags).toHaveLength(1);

    const flagResponse = result.flags[0]!;
    expect(flagResponse.flag_type).toBe("parse_error");
    expect(flagResponse.memory.title).toBe("Real Title");
    expect(flagResponse.memory.content).toBe("real content");
    expect(flagResponse.memory.scope).toBe("workspace");
    expect(flagResponse.reason).toBe(
      "Parse error in workspaces/ws-1/memories/x.md: boom",
    );

    expect(deps.createFlag).toHaveBeenCalledWith({
      memoryId: "mem-1",
      flagType: "parse_error",
      severity: "needs_review",
      details: { reason: "Parse error in workspaces/ws-1/memories/x.md: boom" },
    });
  });

  it("resolves each resolvable flag and increments `resolved` counter", async () => {
    const deps = makeDeps();
    deps.resolveFlag.mockResolvedValue(undefined);

    const checker: ParseErrorChecker = {
      check: async () => ({
        errors: [],
        resolvable: [
          { memoryId: "mem-a", flagId: "flag-a" },
          { memoryId: "mem-b", flagId: "flag-b" },
        ],
      }),
    };

    const svc = new ConsolidationService(
      deps.memoryRepo,
      deps.flagService,
      deps.auditService,
      "proj-1",
      config,
      undefined,
      undefined,
      checker,
    );

    const result = await svc.run();

    expect(result.resolved).toBe(2);
    expect(result.errors).toBe(0);
    expect(deps.resolveFlag).toHaveBeenCalledTimes(2);
    expect(deps.resolveFlag).toHaveBeenCalledWith(
      "flag-a",
      "consolidation",
      "accepted",
    );
    expect(deps.resolveFlag).toHaveBeenCalledWith(
      "flag-b",
      "consolidation",
      "accepted",
    );
  });

  it("counts createFlag failures in `errors`, does not abort other entries", async () => {
    const deps = makeDeps();
    deps.findById.mockResolvedValue(stubMemory());
    deps.createFlag
      .mockRejectedValueOnce(new Error("DB down"))
      .mockResolvedValueOnce(stubFlag({ id: "flag-2", memory_id: "mem-2" }));

    const checker: ParseErrorChecker = {
      check: async () => ({
        errors: [
          { memoryId: "mem-1", path: "a.md", reason: "boom" },
          { memoryId: "mem-2", path: "b.md", reason: "splat" },
        ],
        resolvable: [],
      }),
    };

    const svc = new ConsolidationService(
      deps.memoryRepo,
      deps.flagService,
      deps.auditService,
      "proj-1",
      config,
      undefined,
      undefined,
      checker,
    );

    const result = await svc.run();

    expect(result.errors).toBe(1);
    expect(result.flagged).toBe(1);
    expect(result.flags).toHaveLength(1);
    expect(deps.createFlag).toHaveBeenCalledTimes(2);
  });

  it("counts resolveFlag failures in `errors`, does not abort other resolvables", async () => {
    const deps = makeDeps();
    deps.resolveFlag
      .mockRejectedValueOnce(new Error("flag vanished"))
      .mockResolvedValueOnce(undefined);

    const checker: ParseErrorChecker = {
      check: async () => ({
        errors: [],
        resolvable: [
          { memoryId: "mem-a", flagId: "flag-a" },
          { memoryId: "mem-b", flagId: "flag-b" },
        ],
      }),
    };

    const svc = new ConsolidationService(
      deps.memoryRepo,
      deps.flagService,
      deps.auditService,
      "proj-1",
      config,
      undefined,
      undefined,
      checker,
    );

    const result = await svc.run();

    expect(result.errors).toBe(1);
    expect(result.resolved).toBe(1);
  });

  it("skips flag creation (no error) when memory vanished between check and write", async () => {
    const deps = makeDeps();
    deps.findById.mockResolvedValue(null);

    const checker: ParseErrorChecker = {
      check: async () => ({
        errors: [{ memoryId: "mem-gone", path: "x.md", reason: "boom" }],
        resolvable: [],
      }),
    };

    const svc = new ConsolidationService(
      deps.memoryRepo,
      deps.flagService,
      deps.auditService,
      "proj-1",
      config,
      undefined,
      undefined,
      checker,
    );

    const result = await svc.run();

    expect(result.flagged).toBe(0);
    expect(result.errors).toBe(0);
    expect(deps.createFlag).not.toHaveBeenCalled();
  });

  it("is a no-op when no ParseErrorChecker is wired (pg backend)", async () => {
    const deps = makeDeps();

    const svc = new ConsolidationService(
      deps.memoryRepo,
      deps.flagService,
      deps.auditService,
      "proj-1",
      config,
      // no pathChecker, no parseErrorChecker
    );

    const result = await svc.run();

    expect(result.flagged).toBe(0);
    expect(result.resolved).toBe(0);
    expect(result.errors).toBe(0);
    expect(deps.createFlag).not.toHaveBeenCalled();
  });
});
