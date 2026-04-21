import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultMemoryRepository } from "../../../../../src/backend/vault/repositories/memory-repository.js";
import { ConflictError } from "../../../../../src/utils/errors.js";
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
  let repo: VaultMemoryRepository;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-memrepo-"));
    repo = await VaultMemoryRepository.create({ root });
  });
  afterEach(async () => {
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
    const pre = await VaultMemoryRepository.create({ root });
    await pre.create({
      ...makeMemory({ id: "preexist" }),
      embedding: [0],
    });

    const repo2 = await VaultMemoryRepository.create({ root });
    expect(await repo2.findById("preexist")).not.toBeNull();
  });
});
