import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";
import type { Memory } from "../../../src/types/memory.js";

const DIMS = 768;
const now = new Date("2026-04-22T00:00:00.000Z");

function embVec(seed: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[seed % DIMS] = 1;
  return v;
}

function makeMemory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    project_id: "p1",
    workspace_id: "ws1",
    content: `body-${id}`,
    title: `T-${id}`,
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

describe.each(factories)(
  "MemoryRepository vector contract — $name",
  (factory) => {
    let backend: TestBackend;
    beforeEach(async () => {
      backend = await factory.create();
      await backend.workspaceRepo.findOrCreate("ws1");
    });
    afterEach(async () => {
      await backend.close();
    });

    it("search returns exact match at rank 1", async () => {
      await backend.memoryRepo.create({
        ...makeMemory("a"),
        embedding: embVec(5),
      });
      await backend.memoryRepo.create({
        ...makeMemory("b"),
        embedding: embVec(200),
      });
      const hits = await backend.memoryRepo.search({
        embedding: embVec(5),
        project_id: "p1",
        workspace_id: "ws1",
        scope: ["workspace"],
        limit: 2,
        min_similarity: 0,
      });
      expect(hits[0].id).toBe("a");
      expect(hits[0].relevance).toBeCloseTo(1, 3);
    });

    it("search excludes archived", async () => {
      await backend.memoryRepo.create({
        ...makeMemory("a"),
        embedding: embVec(5),
      });
      await backend.memoryRepo.archive(["a"]);
      const hits = await backend.memoryRepo.search({
        embedding: embVec(5),
        project_id: "p1",
        workspace_id: "ws1",
        scope: ["workspace"],
        limit: 10,
        min_similarity: 0,
      });
      expect(hits).toEqual([]);
    });

    it("findDuplicates returns top workspace-scope match above threshold", async () => {
      await backend.memoryRepo.create({
        ...makeMemory("a"),
        embedding: embVec(5),
      });
      const hits = await backend.memoryRepo.findDuplicates({
        embedding: embVec(5),
        projectId: "p1",
        workspaceId: "ws1",
        scope: "workspace",
        userId: "ignored",
        threshold: 0.9,
      });
      expect(hits.map((h) => h.id)).toEqual(["a"]);
    });

    it("findPairwiseSimilar surfaces near-dupes", async () => {
      const v = embVec(10);
      const w = [...v];
      w[11] = 0.01;
      await backend.memoryRepo.create({
        ...makeMemory("a"),
        embedding: v,
      });
      await backend.memoryRepo.create({
        ...makeMemory("b"),
        embedding: w,
      });
      const pairs = await backend.memoryRepo.findPairwiseSimilar({
        projectId: "p1",
        workspaceId: "ws1",
        scope: "workspace",
        threshold: 0.9,
      });
      const ids = pairs.map((p) => [p.memory_a_id, p.memory_b_id].sort());
      expect(ids).toContainEqual(["a", "b"]);
    });

    it("listWithEmbeddings returns stored embeddings", async () => {
      await backend.memoryRepo.create({
        ...makeMemory("a"),
        embedding: embVec(5),
      });
      const rows = await backend.memoryRepo.listWithEmbeddings({
        projectId: "p1",
        workspaceId: "ws1",
        scope: "workspace",
        limit: 10,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].embedding).toHaveLength(DIMS);
      expect(rows[0].embedding[5]).toBeCloseTo(1, 5);
    });

    it("findDuplicates excludes archived rows", async () => {
      await backend.memoryRepo.create({
        ...makeMemory("a"),
        embedding: embVec(5),
      });
      await backend.memoryRepo.archive(["a"]);
      const hits = await backend.memoryRepo.findDuplicates({
        embedding: embVec(5),
        projectId: "p1",
        workspaceId: "ws1",
        scope: "workspace",
        userId: "ignored",
        threshold: 0.9,
      });
      expect(hits).toEqual([]);
    });

    it("findPairwiseSimilar excludes archived rows", async () => {
      const v = embVec(10);
      const w = [...v];
      w[11] = 0.01;
      await backend.memoryRepo.create({ ...makeMemory("a"), embedding: v });
      await backend.memoryRepo.create({ ...makeMemory("b"), embedding: w });
      await backend.memoryRepo.archive(["a"]);
      const pairs = await backend.memoryRepo.findPairwiseSimilar({
        projectId: "p1",
        workspaceId: "ws1",
        scope: "workspace",
        threshold: 0.9,
      });
      const ids = pairs.flatMap((p) => [p.memory_a_id, p.memory_b_id]);
      expect(ids).not.toContain("a");
    });

    it("listWithEmbeddings excludes archived rows", async () => {
      await backend.memoryRepo.create({
        ...makeMemory("a"),
        embedding: embVec(5),
      });
      await backend.memoryRepo.create({
        ...makeMemory("b"),
        embedding: embVec(6),
      });
      await backend.memoryRepo.archive(["a"]);
      const rows = await backend.memoryRepo.listWithEmbeddings({
        projectId: "p1",
        workspaceId: "ws1",
        scope: "workspace",
        limit: 10,
      });
      expect(rows.map((r) => r.id)).toEqual(["b"]);
    });

    it("findDuplicates honors project scope", async () => {
      await backend.memoryRepo.create({
        ...makeMemory("p-hit", { scope: "project", workspace_id: null }),
        embedding: embVec(7),
      });
      await backend.memoryRepo.create({
        ...makeMemory("ws-noise", { scope: "workspace" }),
        embedding: embVec(7),
      });
      const hits = await backend.memoryRepo.findDuplicates({
        embedding: embVec(7),
        projectId: "p1",
        workspaceId: null,
        scope: "project",
        userId: "ignored",
        threshold: 0.9,
      });
      expect(hits.map((h) => h.id)).toEqual(["p-hit"]);
    });
  },
);
