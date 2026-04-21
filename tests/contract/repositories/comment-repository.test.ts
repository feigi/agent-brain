import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";
import type { Memory } from "../../../src/types/memory.js";

const ZERO_EMB = new Array(768).fill(0);

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date("2026-04-21T00:00:00.000Z");
  return {
    id: "m1",
    project_id: "p1",
    workspace_id: "ws1",
    content: "body",
    title: "T",
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "chris",
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

describe.each(factories)("CommentRepository contract — $name", (factory) => {
  let backend: TestBackend;
  beforeEach(async () => {
    backend = await factory.create();
    await backend.workspaceRepo.findOrCreate("ws1");
    await backend.memoryRepo.create({ ...makeMemory(), embedding: ZERO_EMB });
  });
  afterEach(async () => {
    await backend.close();
  });

  it("create + findByMemoryId round-trips a comment", async () => {
    await backend.commentRepo.create({
      id: "c1",
      memory_id: "m1",
      author: "chris",
      content: "first",
    });
    const found = await backend.commentRepo.findByMemoryId("m1");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: "c1",
      memory_id: "m1",
      author: "chris",
      content: "first",
    });
    expect(found[0]!.created_at).toBeInstanceOf(Date);
  });

  it("findByMemoryId returns empty for unknown memory", async () => {
    expect(await backend.commentRepo.findByMemoryId("nope")).toEqual([]);
  });

  it("findByMemoryId sorts oldest-first (chronological)", async () => {
    await backend.commentRepo.create({
      id: "c1",
      memory_id: "m1",
      author: "a",
      content: "first",
    });
    await new Promise((r) => setTimeout(r, 5));
    await backend.commentRepo.create({
      id: "c2",
      memory_id: "m1",
      author: "b",
      content: "second",
    });
    const found = await backend.commentRepo.findByMemoryId("m1");
    expect(found.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("create bumps parent memory updated_at + last_comment_at (not version)", async () => {
    const before = await backend.memoryRepo.findById("m1");
    expect(before?.version).toBe(1);
    expect(before?.last_comment_at).toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    await backend.commentRepo.create({
      id: "c1",
      memory_id: "m1",
      author: "chris",
      content: "hey",
    });

    const after = await backend.memoryRepo.findById("m1");
    expect(after?.version).toBe(1); // unchanged
    expect(after?.last_comment_at).toBeInstanceOf(Date);
    expect(after!.last_comment_at!.getTime()).toBeGreaterThanOrEqual(
      before!.created_at.getTime(),
    );
    expect(after!.updated_at.getTime()).toBeGreaterThan(
      before!.updated_at.getTime(),
    );
  });

  it("countByMemoryId reflects created comments", async () => {
    expect(await backend.commentRepo.countByMemoryId("m1")).toBe(0);
    await backend.commentRepo.create({
      id: "c1",
      memory_id: "m1",
      author: "a",
      content: "x",
    });
    await backend.commentRepo.create({
      id: "c2",
      memory_id: "m1",
      author: "b",
      content: "y",
    });
    expect(await backend.commentRepo.countByMemoryId("m1")).toBe(2);
  });

  it("countByMemoryId returns 0 for unknown memory", async () => {
    expect(await backend.commentRepo.countByMemoryId("nope")).toBe(0);
  });

  it("findByMemoryIds returns comments across multiple memories", async () => {
    await backend.memoryRepo.create({
      ...makeMemory({ id: "m2" }),
      embedding: ZERO_EMB,
    });
    await backend.commentRepo.create({
      id: "c1",
      memory_id: "m1",
      author: "a",
      content: "m1",
    });
    await new Promise((r) => setTimeout(r, 5));
    await backend.commentRepo.create({
      id: "c2",
      memory_id: "m2",
      author: "b",
      content: "m2",
    });
    const found = await backend.commentRepo.findByMemoryIds(["m1", "m2"]);
    expect(found.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("findByMemoryIds returns empty for empty input", async () => {
    expect(await backend.commentRepo.findByMemoryIds([])).toEqual([]);
  });

  it("multi-line content round-trips", async () => {
    const content = "line 1\n\nline 3\nline 4";
    await backend.commentRepo.create({
      id: "c1",
      memory_id: "m1",
      author: "chris",
      content,
    });
    const [found] = await backend.commentRepo.findByMemoryId("m1");
    expect(found?.content).toBe(content);
  });

  it("create rejects when memory_id does not exist", async () => {
    await expect(
      backend.commentRepo.create({
        id: "c-ghost",
        memory_id: "missing",
        author: "chris",
        content: "x",
      }),
    ).rejects.toThrow();
  });

  it("findByMemoryIds silently skips unknown ids mixed with real ones", async () => {
    await backend.commentRepo.create({
      id: "c1",
      memory_id: "m1",
      author: "a",
      content: "real",
    });
    const found = await backend.commentRepo.findByMemoryIds(["m1", "ghost"]);
    expect(found.map((c) => c.id)).toEqual(["c1"]);
  });

  it("concurrent create on same memory preserves all comments", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    await Promise.all(
      ids.map((id) =>
        backend.commentRepo.create({
          id,
          memory_id: "m1",
          author: "chris",
          content: id,
        }),
      ),
    );
    expect(await backend.commentRepo.countByMemoryId("m1")).toBe(5);
    const found = await backend.commentRepo.findByMemoryId("m1");
    expect(found.map((c) => c.id).sort()).toEqual(ids);
  });
});
