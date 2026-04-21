import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";
import type { AuditEntry } from "../../../src/types/audit.js";
import type { Memory } from "../../../src/types/memory.js";

const ZERO_EMB = new Array(768).fill(0);

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "a1",
    project_id: "p1",
    memory_id: "m1",
    action: "created",
    actor: "chris",
    reason: null,
    diff: null,
    created_at: new Date("2026-04-21T00:00:00.000Z"),
    ...overrides,
  };
}

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

describe.each(factories)("AuditRepository contract — $name", (factory) => {
  let backend: TestBackend;
  beforeEach(async () => {
    backend = await factory.create();
    // pg enforces FK audit_log.memory_id → memories.id — seed a memory
    // so create() doesn't fail on pg. Vault tolerates missing memories.
    await backend.workspaceRepo.findOrCreate("ws1");
    await backend.memoryRepo.create({ ...makeMemory(), embedding: ZERO_EMB });
  });
  afterEach(async () => {
    await backend.close();
  });

  it("create + findByMemoryId returns the entry", async () => {
    await backend.auditRepo.create(makeEntry());
    const found = await backend.auditRepo.findByMemoryId("m1");
    expect(found).toHaveLength(1);
    expect(found[0]!.action).toBe("created");
    expect(found[0]!.actor).toBe("chris");
  });

  it("findByMemoryId returns empty array for unknown memory", async () => {
    expect(await backend.auditRepo.findByMemoryId("nope")).toEqual([]);
  });

  it("findByMemoryId returns entries ordered by created_at desc", async () => {
    const base = new Date("2026-04-21T00:00:00.000Z").getTime();
    await backend.auditRepo.create(
      makeEntry({ id: "a1", created_at: new Date(base) }),
    );
    await backend.auditRepo.create(
      makeEntry({ id: "a2", created_at: new Date(base + 1000) }),
    );
    await backend.auditRepo.create(
      makeEntry({ id: "a3", created_at: new Date(base + 500) }),
    );
    const found = await backend.auditRepo.findByMemoryId("m1");
    expect(found.map((e) => e.id)).toEqual(["a2", "a3", "a1"]);
  });

  it("preserves diff and reason payloads across roundtrip", async () => {
    const diff = { content: ["old", "new"], tags: [["x"], ["x", "y"]] };
    await backend.auditRepo.create(
      makeEntry({
        action: "updated",
        reason: "refactor",
        diff,
      }),
    );
    const [entry] = await backend.auditRepo.findByMemoryId("m1");
    expect(entry?.reason).toBe("refactor");
    expect(entry?.diff).toEqual(diff);
    expect(entry?.action).toBe("updated");
  });

  it("preserves caller-supplied created_at byte-for-byte", async () => {
    const iso = "2020-01-01T00:00:00.000Z";
    await backend.auditRepo.create(makeEntry({ created_at: new Date(iso) }));
    const [entry] = await backend.auditRepo.findByMemoryId("m1");
    expect(entry?.created_at.toISOString()).toBe(iso);
  });
});
