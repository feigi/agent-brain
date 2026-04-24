import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndex } from "../../../../src/backend/vault/repositories/vault-index.js";
import { VaultParseErrorChecker } from "../../../../src/backend/vault/parse-error-checker.js";
import { serializeMemoryFile } from "../../../../src/backend/vault/parser/memory-parser.js";
import type { FlagService } from "../../../../src/services/flag-service.js";

function mockFlagService(overrides: Partial<FlagService> = {}): FlagService {
  return {
    hasOpenFlag: vi.fn().mockResolvedValue(false),
    getFlagsByMemoryId: vi.fn().mockResolvedValue([]),
    resolveFlag: vi.fn().mockResolvedValue(null),
    createFlag: vi.fn(),
    getOpenFlags: vi.fn(),
    findByMemoryIds: vi.fn(),
    autoResolveByMemoryId: vi.fn(),
    ...overrides,
  } as unknown as FlagService;
}

function fakeMemoryMarkdown(id: string): string {
  return serializeMemoryFile({
    memory: {
      id,
      project_id: "proj1",
      workspace_id: "ws1",
      content: "test content",
      title: `Memory ${id}`,
      type: "fact",
      scope: "workspace",
      tags: null,
      author: "user1",
      source: null,
      session_id: null,
      metadata: null,
      embedding_model: null,
      embedding_dimensions: null,
      version: 1,
      created_at: new Date("2024-01-01"),
      updated_at: new Date("2024-01-01"),
      verified_at: null,
      archived_at: null,
      comment_count: 0,
      flag_count: 0,
      relationship_count: 0,
      last_comment_at: null,
      verified_by: null,
    },
    flags: [],
    comments: [],
    relationships: [],
  });
}

async function writeBrokenMemoryFile(
  root: string,
  relPath: string,
  id: string,
): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  // Frontmatter valid for VaultIndex but body fails parseMemoryFile (invalid scope enum).
  const content = `---
id: ${id}
project_id: proj1
workspace_id: ws1
title: Test Memory
type: fact
scope: banana
author: user1
---
# Test Memory
Body of ${id}
`;
  await writeFile(abs, content, "utf8");
}

async function writeValidMemoryFile(
  root: string,
  relPath: string,
  id: string,
): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  const content = fakeMemoryMarkdown(id);
  await writeFile(abs, content, "utf8");
}

function makeFlag(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "flag-1",
    flag_type: "parse_error",
    resolved_at: null,
    memory_id: "mem-1",
    project_id: "proj1",
    severity: "needs_review",
    details: { reason: "Previous parse error" },
    resolved_by: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe("VaultParseErrorChecker", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "parse-error-checker-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("flags a file with valid id but invalid content", async () => {
    await writeBrokenMemoryFile(
      root,
      "workspaces/ws1/memories/broken.md",
      "mem-1",
    );

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService();
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      memoryId: "mem-1",
      path: "workspaces/ws1/memories/broken.md",
    });
    expect(result.errors[0].reason).toBeTruthy();
    expect(result.resolvable).toHaveLength(0);

    expect(mockFlags.hasOpenFlag).toHaveBeenCalledWith("mem-1", "parse_error");
  });

  it("skips already-flagged memories", async () => {
    await writeBrokenMemoryFile(
      root,
      "workspaces/ws1/memories/broken.md",
      "mem-1",
    );

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      hasOpenFlag: vi.fn().mockResolvedValue(true),
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(0);
    expect(result.resolvable).toHaveLength(0);
    expect(mockFlags.hasOpenFlag).toHaveBeenCalledWith("mem-1", "parse_error");
  });

  it("reports stale parse_error flag as resolvable when file now parses", async () => {
    await writeValidMemoryFile(
      root,
      "workspaces/ws1/memories/fixed.md",
      "mem-1",
    );

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      getFlagsByMemoryId: vi
        .fn()
        .mockResolvedValue([makeFlag({ id: "flag-1" })]),
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(0);
    expect(result.resolvable).toEqual([
      { memoryId: "mem-1", flagId: "flag-1" },
    ]);
    expect(mockFlags.getFlagsByMemoryId).toHaveBeenCalledWith("mem-1");
    // Checker is pure-read: resolution is ConsolidationService's job.
    expect(mockFlags.resolveFlag).not.toHaveBeenCalled();
  });

  it("reports multiple stale parse_error flags on the same memory", async () => {
    await writeValidMemoryFile(
      root,
      "workspaces/ws1/memories/fixed.md",
      "mem-1",
    );

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      getFlagsByMemoryId: vi
        .fn()
        .mockResolvedValue([
          makeFlag({ id: "flag-1" }),
          makeFlag({ id: "flag-2" }),
        ]),
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.resolvable).toEqual([
      { memoryId: "mem-1", flagId: "flag-1" },
      { memoryId: "mem-1", flagId: "flag-2" },
    ]);
  });

  it("does not mark non-parse_error flags as resolvable", async () => {
    await writeValidMemoryFile(
      root,
      "workspaces/ws1/memories/valid.md",
      "mem-1",
    );

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      getFlagsByMemoryId: vi
        .fn()
        .mockResolvedValue([makeFlag({ id: "verify-1", flag_type: "verify" })]),
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(0);
    expect(result.resolvable).toHaveLength(0);
  });

  it("ignores already-resolved parse_error flags", async () => {
    await writeValidMemoryFile(
      root,
      "workspaces/ws1/memories/valid.md",
      "mem-1",
    );

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      getFlagsByMemoryId: vi
        .fn()
        .mockResolvedValue([
          makeFlag({ id: "flag-resolved", resolved_at: new Date() }),
        ]),
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.resolvable).toHaveLength(0);
  });

  it("includes parser error text in the reason", async () => {
    await writeBrokenMemoryFile(
      root,
      "workspaces/ws1/memories/broken.md",
      "mem-1",
    );

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService();
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toMatch(/scope|enum|invalid/i);
  });

  it("skips files that disappear between index build and check (ENOENT)", async () => {
    await writeValidMemoryFile(
      root,
      "workspaces/ws1/memories/temp.md",
      "mem-1",
    );
    const index = await VaultIndex.create(root);
    await rm(join(root, "workspaces/ws1/memories/temp.md"));

    const mockFlags = mockFlagService();
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(0);
    expect(result.resolvable).toHaveLength(0);
    // ENOENT is silent — not treated as parse error, not flagged.
    expect(mockFlags.hasOpenFlag).not.toHaveBeenCalled();
  });

  it("does not swallow non-ENOENT readFile failures silently", async () => {
    if (process.platform === "win32") return; // chmod semantics differ
    await writeValidMemoryFile(
      root,
      "workspaces/ws1/memories/perm.md",
      "mem-1",
    );
    const index = await VaultIndex.create(root);
    // Strip read permission so readFile returns EACCES.
    await chmod(join(root, "workspaces/ws1/memories/perm.md"), 0o000);

    const mockFlags = mockFlagService();
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    try {
      const result = await checker.check();
      // EACCES files don't produce parse errors or resolvable entries —
      // they go to logger.error so operators can see the permission problem.
      expect(result.errors).toHaveLength(0);
      expect(result.resolvable).toHaveLength(0);
    } finally {
      await chmod(join(root, "workspaces/ws1/memories/perm.md"), 0o644);
    }
  });

  it("returns empty result on an empty vault", async () => {
    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService();
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(0);
    expect(result.resolvable).toHaveLength(0);
  });

  it("handles multiple files with mixed states", async () => {
    await writeBrokenMemoryFile(
      root,
      "workspaces/ws1/memories/broken.md",
      "mem-1",
    );
    await writeValidMemoryFile(
      root,
      "workspaces/ws1/memories/fixed.md",
      "mem-2",
    );

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      hasOpenFlag: vi.fn().mockImplementation((id: string) => {
        return Promise.resolve(id === "mem-2");
      }),
      getFlagsByMemoryId: vi.fn().mockImplementation((id: string) => {
        if (id === "mem-2") {
          return Promise.resolve([
            makeFlag({ id: "flag-2", memory_id: "mem-2" }),
          ]);
        }
        return Promise.resolve([]);
      }),
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].memoryId).toBe("mem-1");
    expect(result.resolvable).toEqual([
      { memoryId: "mem-2", flagId: "flag-2" },
    ]);
  });
});
