import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";
import type { Memory } from "../../../src/types/memory.js";
import { ConflictError } from "../../../src/utils/errors.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date("2026-04-21T00:00:00.000Z");
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

// Zero-vector embedding — pg stores it, vault ignores it.
// Default embedding dimensions are 768 (see src/config.ts).
const ZERO_EMB = new Array(768).fill(0);

describe.each(factories)(
  "MemoryRepository contract — $name",
  (factory) => {
    let backend: TestBackend;
    beforeEach(async () => {
      backend = await factory.create();
      // Ensure workspace exists for FK-enforcing backends.
      await backend.workspaceRepo.findOrCreate("ws1");
    });
    afterEach(async () => {
      await backend.close();
    });

    it("create + findById round-trips title and content", async () => {
      const m = makeMemory();
      await backend.memoryRepo.create({ ...m, embedding: ZERO_EMB });
      const got = await backend.memoryRepo.findById("m1");
      expect(got?.title).toBe("Title");
      expect(got?.content).toBe("body");
    });

    it("findById returns null for archived", async () => {
      await backend.memoryRepo.create({
        ...makeMemory(),
        embedding: ZERO_EMB,
      });
      await backend.memoryRepo.archive(["m1"]);
      expect(await backend.memoryRepo.findById("m1")).toBeNull();
    });

    it("findByIdIncludingArchived returns archived memory", async () => {
      await backend.memoryRepo.create({
        ...makeMemory(),
        embedding: ZERO_EMB,
      });
      await backend.memoryRepo.archive(["m1"]);
      const inc = await backend.memoryRepo.findByIdIncludingArchived("m1");
      expect(inc?.archived_at).not.toBeNull();
    });

    it("update bumps version", async () => {
      await backend.memoryRepo.create({
        ...makeMemory(),
        embedding: ZERO_EMB,
      });
      const next = await backend.memoryRepo.update("m1", 1, {
        content: "updated",
      });
      expect(next.version).toBe(2);
      expect(next.content).toBe("updated");
    });

    it("update with wrong expectedVersion throws ConflictError", async () => {
      await backend.memoryRepo.create({
        ...makeMemory(),
        embedding: ZERO_EMB,
      });
      await expect(
        backend.memoryRepo.update("m1", 42, { content: "x" }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("list returns created memories ordered by created_at desc", async () => {
      const base = new Date("2026-04-21T00:00:00.000Z");
      for (let i = 0; i < 3; i++) {
        await backend.memoryRepo.create({
          ...makeMemory({
            id: `id${i}`,
            created_at: new Date(base.getTime() + i * 1000),
            updated_at: new Date(base.getTime() + i * 1000),
          }),
          embedding: ZERO_EMB,
        });
      }
      const { memories } = await backend.memoryRepo.list({
        project_id: "p1",
        workspace_id: "ws1",
        scope: ["workspace"],
        limit: 10,
      });
      expect(memories.map((m) => m.id)).toEqual(["id2", "id1", "id0"]);
    });

    it("verify sets verified_by and verified_at", async () => {
      await backend.memoryRepo.create({
        ...makeMemory(),
        embedding: ZERO_EMB,
      });
      const v = await backend.memoryRepo.verify("m1", "chris");
      expect(v?.verified_by).toBe("chris");
      expect(v?.verified_at).toBeInstanceOf(Date);
    });

    it("archive returns count and excludes from list", async () => {
      await backend.memoryRepo.create({
        ...makeMemory({ id: "a" }),
        embedding: ZERO_EMB,
      });
      await backend.memoryRepo.create({
        ...makeMemory({ id: "b" }),
        embedding: ZERO_EMB,
      });
      const count = await backend.memoryRepo.archive(["a", "b", "missing"]);
      expect(count).toBe(2);
      const { memories } = await backend.memoryRepo.list({
        project_id: "p1",
        workspace_id: "ws1",
        scope: ["workspace"],
      });
      expect(memories).toHaveLength(0);
    });
  },
);
