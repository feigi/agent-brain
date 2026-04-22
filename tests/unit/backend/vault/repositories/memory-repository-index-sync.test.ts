import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultMemoryRepository } from "../../../../../src/backend/vault/repositories/memory-repository.js";
import { VaultWorkspaceRepository } from "../../../../../src/backend/vault/repositories/workspace-repository.js";
import { VaultVectorIndex } from "../../../../../src/backend/vault/vector/lance-index.js";
import { ValidationError } from "../../../../../src/utils/errors.js";
import type { Memory } from "../../../../../src/types/memory.js";

const DIMS = 3;
const now = new Date("2026-04-22T00:00:00.000Z");

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    project_id: "p1",
    workspace_id: "ws1",
    content: "body",
    title: "Title",
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "a",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: null,
    embedding_dimensions: DIMS,
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

describe("VaultMemoryRepository — lance index sync", () => {
  let root: string;
  let idx: VaultVectorIndex;
  let repo: VaultMemoryRepository;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repo-sync-"));
    idx = await VaultVectorIndex.create({ root, dims: DIMS });
    repo = await VaultMemoryRepository.create({ root, index: idx });
    await new VaultWorkspaceRepository({ root }).findOrCreate("ws1");
  });

  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("archive flips the lance row's archived flag", async () => {
    await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
    expect(await idx.countRows()).toBe(1);
    await repo.archive(["m1"]);
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits).toEqual([]);
  });

  it("update with new embedding replaces the vector", async () => {
    await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
    await repo.update("m1", 1, { content: "new", embedding: [0, 1, 0] });
    const hits = await idx.search({
      embedding: [0, 1, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0.9,
    });
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
  });

  it("update with no embedding preserves existing vector + updates meta", async () => {
    await repo.create({
      ...makeMemory({ title: "Old" }),
      embedding: [1, 0, 0],
    });
    await repo.update("m1", 1, { title: "New" });
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 1,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("m1");
  });

  describe("lance write-failure swallow (markdown = source of truth)", () => {
    it("create: lance upsert throw → markdown persists, caller sees success, warn logged", async () => {
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(idx, "upsert").mockRejectedValueOnce(new Error("lance boom"));

      const saved = await repo.create({
        ...makeMemory(),
        embedding: [1, 0, 0],
      });
      expect(saved.id).toBe("m1");

      const body = await readFile(
        join(root, "workspaces/ws1/memories/m1.md"),
        "utf8",
      );
      expect(body).toContain("m1");

      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-brain] WARN:",
        "lance upsert failed on create; index stale",
        expect.objectContaining({ id: "m1", op: "create" }),
      );
      warnSpy.mockRestore();
    });

    it("update: lance upsert throw → markdown persists, caller sees success, warn logged", async () => {
      await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(idx, "upsert").mockRejectedValueOnce(new Error("lance boom"));

      const next = await repo.update("m1", 1, {
        content: "updated",
        embedding: [0, 1, 0],
      });
      expect(next.content).toBe("updated");
      expect(next.version).toBe(2);

      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-brain] WARN:",
        "lance upsert failed on update; index stale",
        expect.objectContaining({ id: "m1", op: "update" }),
      );
      warnSpy.mockRestore();
    });

    it("update meta-only: missing lance row → drift warn logged, caller sees success", async () => {
      await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // Force meta-only upsert to report zero-row match (simulated drift)
      vi.spyOn(idx, "upsertMetaOnly").mockResolvedValueOnce(0);

      const next = await repo.update("m1", 1, { title: "Renamed" });
      expect(next.title).toBe("Renamed");

      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-brain] WARN:",
        "lance meta-only update matched no rows; index drift",
        expect.objectContaining({ id: "m1", op: "update" }),
      );
      warnSpy.mockRestore();
    });

    it("archive: lance failure on one id does not abort loop for others", async () => {
      await repo.create({ ...makeMemory({ id: "a" }), embedding: [1, 0, 0] });
      await repo.create({ ...makeMemory({ id: "b" }), embedding: [0, 1, 0] });
      await repo.create({ ...makeMemory({ id: "c" }), embedding: [0, 0, 1] });
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // First archive call throws, subsequent calls succeed.
      const spy = vi
        .spyOn(idx, "markArchived")
        .mockImplementationOnce(async () => {
          throw new Error("lance boom");
        });

      const count = await repo.archive(["a", "b", "c"]);
      expect(count).toBe(3);
      expect(spy).toHaveBeenCalledTimes(3);

      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-brain] WARN:",
        "lance markArchived failed; index stale",
        expect.objectContaining({ id: "a", op: "archive" }),
      );
      // b and c should have been flipped in lance despite a's failure.
      const bStillVisible = await idx.search({
        embedding: [0, 1, 0],
        projectId: "p1",
        workspaceId: "ws1",
        scope: ["workspace"],
        userId: null,
        limit: 10,
        minSimilarity: 0,
      });
      expect(bStillVisible.map((h) => h.id)).not.toContain("b");
      warnSpy.mockRestore();
    });

    it("archive: missing lance row → drift warn, caller count reflects markdown", async () => {
      await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(idx, "markArchived").mockResolvedValueOnce(0);

      const count = await repo.archive(["m1"]);
      expect(count).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-brain] WARN:",
        "lance markArchived matched no rows; index drift",
        expect.objectContaining({ id: "m1", op: "archive" }),
      );
      warnSpy.mockRestore();
    });
  });

  describe("pre-write dimension guard", () => {
    it("create: wrong-dim embedding → ValidationError before any fs write", async () => {
      await expect(
        repo.create({ ...makeMemory(), embedding: [1, 0, 0, 0] }),
      ).rejects.toBeInstanceOf(ValidationError);
      // Markdown must NOT have been written.
      await expect(
        readFile(join(root, "workspaces/ws1/memories/m1.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // Lance row count unchanged (still 0).
      expect(await idx.countRows()).toBe(0);
    });

    it("update: wrong-dim embedding → ValidationError, markdown unchanged", async () => {
      await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
      await expect(
        repo.update("m1", 1, { embedding: [1, 0] }),
      ).rejects.toBeInstanceOf(ValidationError);
      // Version should still be 1 (no write committed).
      const current = await repo.findById("m1");
      expect(current?.version).toBe(1);
    });
  });
});
