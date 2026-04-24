import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
  // Valid frontmatter for VaultIndex but invalid scope for parseMemoryFile
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

describe("VaultParseErrorChecker", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "parse-error-checker-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("flags a file with valid id but invalid content", async () => {
    // Create a file that VaultIndex can index but parseMemoryFile will reject
    await writeBrokenMemoryFile(root, "workspaces/ws1/memories/broken.md", "mem-1");

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService();
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      memoryId: "mem-1",
      path: "workspaces/ws1/memories/broken.md",
      reason: expect.stringContaining("banana"), // Invalid scope value
    });
    expect(result.resolved).toHaveLength(0);

    // Verify hasOpenFlag was called to check for existing flags
    expect(mockFlags.hasOpenFlag).toHaveBeenCalledWith("mem-1", "parse_error");
  });

  it("skips already-flagged memories", async () => {
    await writeBrokenMemoryFile(root, "workspaces/ws1/memories/broken.md", "mem-1");

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      hasOpenFlag: vi.fn().mockResolvedValue(true), // Already flagged
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(0); // No duplicate flag
    expect(result.resolved).toHaveLength(0);
    expect(mockFlags.hasOpenFlag).toHaveBeenCalledWith("mem-1", "parse_error");
  });

  it("auto-resolves stale flag when file now parses", async () => {
    // Create a valid memory file
    await writeValidMemoryFile(root, "workspaces/ws1/memories/fixed.md", "mem-1");

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      hasOpenFlag: vi.fn().mockResolvedValue(true), // Has stale flag
      getFlagsByMemoryId: vi.fn().mockResolvedValue([
        {
          id: "flag-1",
          flag_type: "parse_error",
          resolved_at: null,
          memory_id: "mem-1",
          project_id: "proj1",
          severity: "needs_review",
          details: { reason: "Previous parse error" },
          resolved_by: null,
          created_at: new Date(),
        },
      ]),
      resolveFlag: vi.fn().mockResolvedValue(null),
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(0);
    expect(result.resolved).toContain("mem-1");

    // Verify the flag was resolved
    expect(mockFlags.getFlagsByMemoryId).toHaveBeenCalledWith("mem-1");
    expect(mockFlags.resolveFlag).toHaveBeenCalledWith("flag-1", "system", "accepted");
  });

  it("does not resolve non-parse_error flags", async () => {
    await writeValidMemoryFile(root, "workspaces/ws1/memories/valid.md", "mem-1");

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      hasOpenFlag: vi.fn().mockResolvedValue(true),
      getFlagsByMemoryId: vi.fn().mockResolvedValue([
        {
          id: "flag-1",
          flag_type: "verify", // Not parse_error
          resolved_at: null,
          memory_id: "mem-1",
          project_id: "proj1",
          severity: "needs_review",
          details: { reason: "Needs verification" },
          resolved_by: null,
          created_at: new Date(),
        },
      ]),
      resolveFlag: vi.fn().mockResolvedValue(null),
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(0);
    expect(result.resolved).toHaveLength(0); // No resolution for verify flag

    // Verify resolveFlag was NOT called for verify flags
    expect(mockFlags.resolveFlag).not.toHaveBeenCalled();
  });

  it("reports correct reason from parse error", async () => {
    await writeBrokenMemoryFile(root, "workspaces/ws1/memories/broken.md", "mem-1");

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService();
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBeTruthy();
    expect(result.errors[0].reason).toMatch(/banana|scope|enum|invalid/i);
  });

  it("handles missing files gracefully", async () => {
    // Create index with a file, then delete the file
    await writeValidMemoryFile(root, "workspaces/ws1/memories/temp.md", "mem-1");
    const index = await VaultIndex.create(root);
    
    // Delete the file after indexing
    await rm(join(root, "workspaces/ws1/memories/temp.md"));

    const mockFlags = mockFlagService();
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    // Should not report parse error for missing file
    expect(result.errors).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
  });

  it("handles multiple files with mixed states", async () => {
    // Create one broken file and one valid file with stale flag
    await writeBrokenMemoryFile(root, "workspaces/ws1/memories/broken.md", "mem-1");
    await writeValidMemoryFile(root, "workspaces/ws1/memories/fixed.md", "mem-2");

    const index = await VaultIndex.create(root);
    const mockFlags = mockFlagService({
      hasOpenFlag: vi.fn().mockImplementation((id, flagType) => {
        if (id === "mem-1" && flagType === "parse_error") return Promise.resolve(false);
        if (id === "mem-2" && flagType === "parse_error") return Promise.resolve(true);
        return Promise.resolve(false);
      }),
      getFlagsByMemoryId: vi.fn().mockImplementation((id) => {
        if (id === "mem-2") {
          return Promise.resolve([
            {
              id: "flag-2",
              flag_type: "parse_error",
              resolved_at: null,
              memory_id: "mem-2",
              project_id: "proj1",
              severity: "needs_review",
              details: { reason: "Previous parse error" },
              resolved_by: null,
              created_at: new Date(),
            },
          ]);
        }
        return Promise.resolve([]);
      }),
      resolveFlag: vi.fn().mockResolvedValue(null),
    });
    const checker = new VaultParseErrorChecker(index, root, mockFlags);

    const result = await checker.check();

    // Should flag the broken file and resolve the fixed file
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].memoryId).toBe("mem-1");
    expect(result.resolved).toContain("mem-2");
    expect(mockFlags.resolveFlag).toHaveBeenCalledWith("flag-2", "system", "accepted");
  });
});