import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultMemoryRepository } from "../../../../../src/backend/vault/repositories/memory-repository.js";
import { VaultVectorIndex } from "../../../../../src/backend/vault/vector/lance-index.js";
import { NOOP_GIT_OPS } from "../../../../../src/backend/vault/git/types.js";
import {
  ConflictError,
  ValidationError,
} from "../../../../../src/utils/errors.js";
import type { Memory } from "../../../../../src/types/memory.js";

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

describe("VaultMemoryRepository — CRUD", () => {
  let root: string;
  let idx: VaultVectorIndex;
  let repo: VaultMemoryRepository;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-memrepo-"));
    idx = await VaultVectorIndex.create({ root, dims: 1 });
    repo = await VaultMemoryRepository.create({
      root,
      index: idx,
      gitOps: NOOP_GIT_OPS,
    });
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("create writes memory file under workspace path", async () => {
    const m = makeMemory();
    const saved = await repo.create({ ...m, embedding: [0] });
    expect(saved.id).toBe("m1");
    const found = await repo.findById("m1");
    expect(found?.title).toBe("Title");
    // File is at workspaces/ws1/memories/m1.md
    const raw = await readFile(
      join(root, "workspaces/ws1/memories/m1.md"),
      "utf8",
    );
    expect(raw).toMatch(/title: Title/);
  });

  it("findById returns null for unknown id", async () => {
    expect(await repo.findById("nope")).toBeNull();
  });

  it("findByIdIncludingArchived returns archived memory", async () => {
    const m = makeMemory();
    await repo.create({ ...m, embedding: [0] });
    await repo.archive(["m1"]);
    expect(await repo.findById("m1")).toBeNull();
    const inc = await repo.findByIdIncludingArchived("m1");
    expect(inc?.archived_at).not.toBeNull();
  });

  it("findByIds returns memories in any order, skips archived and missing", async () => {
    await repo.create({ ...makeMemory({ id: "a" }), embedding: [0] });
    await repo.create({ ...makeMemory({ id: "b" }), embedding: [0] });
    await repo.create({ ...makeMemory({ id: "c" }), embedding: [0] });
    await repo.archive(["b"]);
    const found = await repo.findByIds(["a", "b", "c", "missing"]);
    expect(found.map((m) => m.id).sort()).toEqual(["a", "c"]);
  });

  it("update bumps version and persists changes", async () => {
    await repo.create({ ...makeMemory(), embedding: [0] });
    const updated = await repo.update("m1", 1, { content: "new body" });
    expect(updated.version).toBe(2);
    expect(updated.content).toBe("new body");
    const found = await repo.findById("m1");
    expect(found?.version).toBe(2);
    expect(found?.content).toBe("new body");
  });

  it("update with wrong expectedVersion throws ConflictError", async () => {
    await repo.create({ ...makeMemory(), embedding: [0] });
    await expect(
      repo.update("m1", 99, { content: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("update on unknown id throws", async () => {
    await expect(repo.update("nope", 1, { content: "x" })).rejects.toThrow();
  });

  it("archive flips archived_at and returns count", async () => {
    await repo.create({ ...makeMemory({ id: "a" }), embedding: [0] });
    await repo.create({ ...makeMemory({ id: "b" }), embedding: [0] });
    const count = await repo.archive(["a", "b", "missing"]);
    expect(count).toBe(2);
    expect(await repo.findById("a")).toBeNull();
    expect(await repo.findById("b")).toBeNull();
  });

  it("verify sets verified_at and verified_by", async () => {
    await repo.create({ ...makeMemory(), embedding: [0] });
    const verified = await repo.verify("m1", "chris");
    expect(verified?.verified_by).toBe("chris");
    expect(verified?.verified_at).toBeInstanceOf(Date);
  });

  it("verify on unknown id returns null", async () => {
    expect(await repo.verify("nope", "chris")).toBeNull();
  });

  it("VaultMemoryRepository.create rebuilds index from existing vault", async () => {
    // Pre-seed a memory via the same repo API on a separate instance,
    // then construct a fresh repo against the same root.
    const pre = await VaultMemoryRepository.create({
      root,
      index: idx,
      gitOps: NOOP_GIT_OPS,
    });
    await pre.create({
      ...makeMemory({ id: "preexist" }),
      embedding: [0],
    });

    const repo2 = await VaultMemoryRepository.create({
      root,
      index: idx,
      gitOps: NOOP_GIT_OPS,
    });
    expect(await repo2.findById("preexist")).not.toBeNull();
  });
});

describe("VaultMemoryRepository — listings", () => {
  let root: string;
  let idx: VaultVectorIndex;
  let repo: VaultMemoryRepository;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-memrepo-list-"));
    idx = await VaultVectorIndex.create({ root, dims: 1 });
    repo = await VaultMemoryRepository.create({
      root,
      index: idx,
      gitOps: NOOP_GIT_OPS,
    });
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("list filters by project + scope + workspace", async () => {
    await repo.create({
      ...makeMemory({
        id: "a",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "b",
        project_id: "p1",
        workspace_id: "ws2",
        scope: "workspace",
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "c",
        project_id: "p2",
        workspace_id: "ws1",
        scope: "workspace",
      }),
      embedding: [0],
    });

    const { memories } = await repo.list({
      project_id: "p1",
      workspace_id: "ws1",
      scope: ["workspace"],
    });
    expect(memories.map((m) => m.id)).toEqual(["a"]);
  });

  it("list applies limit + cursor (created_at desc default)", async () => {
    const now = new Date("2026-04-21T00:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await repo.create({
        ...makeMemory({
          id: `id${i}`,
          project_id: "p",
          workspace_id: "ws",
          created_at: new Date(now.getTime() + i * 1000),
          updated_at: new Date(now.getTime() + i * 1000),
        }),
        embedding: [0],
      });
    }
    const page1 = await repo.list({
      project_id: "p",
      workspace_id: "ws",
      scope: ["workspace"],
      limit: 2,
    });
    expect(page1.memories.map((m) => m.id)).toEqual(["id4", "id3"]);
    expect(page1.has_more).toBe(true);

    const page2 = await repo.list({
      project_id: "p",
      workspace_id: "ws",
      scope: ["workspace"],
      limit: 2,
      cursor: page1.cursor,
    });
    expect(page2.memories.map((m) => m.id)).toEqual(["id2", "id1"]);
  });

  it("list excludes archived memories", async () => {
    await repo.create({
      ...makeMemory({ id: "a", project_id: "p", workspace_id: "ws" }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({ id: "b", project_id: "p", workspace_id: "ws" }),
      embedding: [0],
    });
    await repo.archive(["a"]);
    const { memories } = await repo.list({
      project_id: "p",
      workspace_id: "ws",
      scope: ["workspace"],
    });
    expect(memories.map((m) => m.id)).toEqual(["b"]);
  });

  it("findStale returns memories older than threshold_days", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const fresh = new Date();
    await repo.create({
      ...makeMemory({
        id: "old",
        project_id: "p",
        workspace_id: "ws",
        created_at: old,
        updated_at: old,
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "fresh",
        project_id: "p",
        workspace_id: "ws",
        created_at: fresh,
        updated_at: fresh,
      }),
      embedding: [0],
    });
    const { memories } = await repo.findStale({
      project_id: "p",
      workspace_id: "ws",
      threshold_days: 14,
    });
    expect(memories.map((m) => m.id)).toEqual(["old"]);
  });

  it("listProjectScoped returns scope=project memories only", async () => {
    await repo.create({
      ...makeMemory({
        id: "p1",
        project_id: "P",
        workspace_id: null,
        scope: "project",
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "ws1",
        project_id: "P",
        workspace_id: "ws",
        scope: "workspace",
      }),
      embedding: [0],
    });
    const found = await repo.listProjectScoped({
      project_id: "P",
      limit: 10,
    });
    expect(found.map((m) => m.id)).toEqual(["p1"]);
  });

  it("listDistinctWorkspaces returns unique workspace ids", async () => {
    await repo.create({
      ...makeMemory({ id: "a", project_id: "P", workspace_id: "w1" }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({ id: "b", project_id: "P", workspace_id: "w2" }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({ id: "c", project_id: "P", workspace_id: "w1" }),
      embedding: [0],
    });
    const ws = await repo.listDistinctWorkspaces("P");
    expect(ws.sort()).toEqual(["w1", "w2"]);
  });

  it("findRecentActivity returns memories updated since cutoff, excluding self", async () => {
    const now = new Date();
    await repo.create({
      ...makeMemory({
        id: "mine",
        project_id: "P",
        workspace_id: "ws",
        author: "me",
        updated_at: now,
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "theirs",
        project_id: "P",
        workspace_id: "ws",
        author: "them",
        updated_at: now,
      }),
      embedding: [0],
    });
    const found = await repo.findRecentActivity({
      project_id: "P",
      workspace_id: "ws",
      user_id: "me",
      since: new Date(now.getTime() - 60_000),
      limit: 10,
      exclude_self: true,
    });
    expect(found.map((m) => m.id)).toEqual(["theirs"]);
  });

  it("countTeamActivity returns counts per category", async () => {
    const now = new Date();
    await repo.create({
      ...makeMemory({
        id: "new1",
        project_id: "P",
        workspace_id: "ws",
        author: "them",
        created_at: now,
        updated_at: now,
      }),
      embedding: [0],
    });
    const counts = await repo.countTeamActivity(
      "P",
      "ws",
      "me",
      new Date(now.getTime() - 60_000),
    );
    expect(counts.new_memories).toBe(1);
    expect(counts.updated_memories).toBe(0); // same as new_memories — updated_at === created_at
    expect(counts.commented_memories).toBe(0);
  });

  it("countTeamActivity classifies updated-not-created with strict boundary", async () => {
    const since = new Date("2026-04-01T00:00:00Z");
    // created_at === since → not counted in either bucket (strict gt).
    await repo.create({
      ...makeMemory({
        id: "edge",
        project_id: "P",
        workspace_id: "ws",
        author: "x",
        created_at: since,
        updated_at: new Date(since.getTime() + 60_000),
      }),
      embedding: [0],
    });
    // created_at < since AND updated_at > since → updated-not-created.
    await repo.create({
      ...makeMemory({
        id: "upd",
        project_id: "P",
        workspace_id: "ws",
        author: "x",
        created_at: new Date(since.getTime() - 60_000),
        updated_at: new Date(since.getTime() + 60_000),
      }),
      embedding: [0],
    });
    const counts = await repo.countTeamActivity("P", "ws", "me", since);
    expect(counts.new_memories).toBe(0);
    expect(counts.updated_memories).toBe(1);
  });
});

describe("VaultMemoryRepository — list validation", () => {
  let root: string;
  let idx: VaultVectorIndex;
  let repo: VaultMemoryRepository;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-memrepo-validate-"));
    idx = await VaultVectorIndex.create({ root, dims: 1 });
    repo = await VaultMemoryRepository.create({
      root,
      index: idx,
      gitOps: NOOP_GIT_OPS,
    });
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("list throws ValidationError on empty scope", async () => {
    await expect(
      repo.list({ project_id: "p", scope: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("list throws ValidationError when workspace scope lacks workspace_id", async () => {
    await expect(
      repo.list({ project_id: "p", scope: ["workspace"] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("list throws ValidationError when user scope lacks user_id", async () => {
    await expect(
      repo.list({ project_id: "p", scope: ["user"] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
