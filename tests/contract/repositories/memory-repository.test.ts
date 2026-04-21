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

describe.each(factories)("MemoryRepository contract — $name", (factory) => {
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

  it("create throws ConflictError on duplicate id", async () => {
    await backend.memoryRepo.create({
      ...makeMemory(),
      embedding: ZERO_EMB,
    });
    await expect(
      backend.memoryRepo.create({ ...makeMemory(), embedding: ZERO_EMB }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("verify returns null for archived memory", async () => {
    await backend.memoryRepo.create({
      ...makeMemory(),
      embedding: ZERO_EMB,
    });
    await backend.memoryRepo.archive(["m1"]);
    const v = await backend.memoryRepo.verify("m1", "chris");
    expect(v).toBeNull();
  });

  it("findStale uses verified_at (COALESCE with created_at)", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const fresh = new Date();
    // Unverified + old created_at → stale
    await backend.memoryRepo.create({
      ...makeMemory({ id: "stale-unv", created_at: old, updated_at: old }),
      embedding: ZERO_EMB,
    });
    // Verified recently + old created_at → NOT stale
    await backend.memoryRepo.create({
      ...makeMemory({
        id: "verified",
        created_at: old,
        updated_at: fresh,
        verified_at: fresh,
        verified_by: "someone",
      }),
      embedding: ZERO_EMB,
    });
    const { memories } = await backend.memoryRepo.findStale({
      project_id: "p1",
      workspace_id: "ws1",
      threshold_days: 14,
    });
    expect(memories.map((m) => m.id)).toEqual(["stale-unv"]);
  });

  it("user-scope create stores at users/<author>/<ws>/<id>.md (vault)", async () => {
    // This is a happy-path cross-backend test — pg doesn't care about
    // paths, but it must still accept the write without throwing.
    const m = makeMemory({
      id: "u1",
      scope: "user",
      workspace_id: "ws1",
      author: "chris",
    });
    await backend.memoryRepo.create({ ...m, embedding: ZERO_EMB });
    const found = await backend.memoryRepo.findById("u1");
    expect(found?.scope).toBe("user");
    expect(found?.author).toBe("chris");
  });

  it("countTeamActivity includes the caller's own changes (D-30)", async () => {
    const now = new Date();
    await backend.memoryRepo.create({
      ...makeMemory({
        id: "mine-new",
        author: "me",
        created_at: now,
        updated_at: now,
      }),
      embedding: ZERO_EMB,
    });
    const counts = await backend.memoryRepo.countTeamActivity(
      "p1",
      "ws1",
      "me",
      new Date(now.getTime() - 60_000),
    );
    expect(counts.new_memories).toBe(1);
  });

  it("update on archived memory throws ConflictError", async () => {
    await backend.memoryRepo.create({
      ...makeMemory(),
      embedding: ZERO_EMB,
    });
    await backend.memoryRepo.archive(["m1"]);
    await expect(
      backend.memoryRepo.update("m1", 1, { content: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("update on unknown id throws ConflictError", async () => {
    await expect(
      backend.memoryRepo.update("missing", 1, { content: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("findRecentActivity includes project-scope memories", async () => {
    const now = new Date();
    await backend.memoryRepo.create({
      ...makeMemory({
        id: "proj",
        scope: "project",
        workspace_id: null,
        author: "them",
        created_at: now,
        updated_at: now,
      }),
      embedding: ZERO_EMB,
    });
    const rows = await backend.memoryRepo.findRecentActivity({
      project_id: "p1",
      workspace_id: "ws1",
      user_id: "me",
      since: new Date(now.getTime() - 60_000),
      limit: 10,
      exclude_self: true,
    });
    expect(rows.some((m) => m.id === "proj")).toBe(true);
  });
});
