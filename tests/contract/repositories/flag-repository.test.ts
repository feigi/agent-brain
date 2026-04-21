import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";
import type { Memory } from "../../../src/types/memory.js";
import type { Flag } from "../../../src/types/flag.js";

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

function makeFlag(overrides: Partial<Flag> = {}): Flag {
  return {
    id: "f1",
    project_id: "p1",
    memory_id: "m1",
    flag_type: "duplicate",
    severity: "needs_review",
    details: { reason: "similar content" },
    resolved_at: null,
    resolved_by: null,
    created_at: new Date("2026-04-21T10:00:00.000Z"),
    ...overrides,
  };
}

describe.each(factories)("FlagRepository contract — $name", (factory) => {
  let backend: TestBackend;
  beforeEach(async () => {
    backend = await factory.create();
    await backend.workspaceRepo.findOrCreate("ws1");
    await backend.workspaceRepo.findOrCreate("ws2");
    await backend.memoryRepo.create({ ...makeMemory(), embedding: ZERO_EMB });
  });
  afterEach(async () => {
    await backend.close();
  });

  it("create + findByMemoryId round-trips", async () => {
    await backend.flagRepo.create(makeFlag());
    const found = await backend.flagRepo.findByMemoryId("m1");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: "f1",
      flag_type: "duplicate",
      severity: "needs_review",
    });
    expect(found[0]!.details.reason).toBe("similar content");
  });

  it("findByMemoryId sorts desc by created_at", async () => {
    await backend.flagRepo.create(
      makeFlag({
        id: "f1",
        created_at: new Date("2026-04-21T10:00:00.000Z"),
      }),
    );
    await backend.flagRepo.create(
      makeFlag({
        id: "f2",
        created_at: new Date("2026-04-21T11:00:00.000Z"),
      }),
    );
    const found = await backend.flagRepo.findByMemoryId("m1");
    expect(found.map((f) => f.id)).toEqual(["f2", "f1"]);
  });

  it("findByMemoryId returns [] for unknown memory", async () => {
    expect(await backend.flagRepo.findByMemoryId("nope")).toEqual([]);
  });

  it("findByMemoryIds returns [] for empty input", async () => {
    expect(await backend.flagRepo.findByMemoryIds([])).toEqual([]);
  });

  it("resolve(accepted) sets resolved_at + resolved_by", async () => {
    await backend.flagRepo.create(makeFlag());
    const resolved = await backend.flagRepo.resolve("f1", "chris", "accepted");
    expect(resolved).not.toBeNull();
    expect(resolved!.resolved_at).toBeInstanceOf(Date);
    expect(resolved!.resolved_by).toBe("chris");
  });

  it("resolve(dismissed) sets resolved_at + resolved_by", async () => {
    await backend.flagRepo.create(makeFlag());
    const resolved = await backend.flagRepo.resolve("f1", "chris", "dismissed");
    expect(resolved).not.toBeNull();
    expect(resolved!.resolved_at).toBeInstanceOf(Date);
    expect(resolved!.resolved_by).toBe("chris");
  });

  it("resolve(deferred) bumps created_at, leaves resolved_at null", async () => {
    const original = new Date("2026-04-21T10:00:00.000Z");
    await backend.flagRepo.create(makeFlag({ created_at: original }));
    await new Promise((r) => setTimeout(r, 10));
    const resolved = await backend.flagRepo.resolve("f1", "chris", "deferred");
    expect(resolved).not.toBeNull();
    expect(resolved!.resolved_at).toBeNull();
    expect(resolved!.created_at.getTime()).toBeGreaterThan(original.getTime());
  });

  it("resolve returns null for unknown flag id", async () => {
    expect(
      await backend.flagRepo.resolve("nope", "chris", "accepted"),
    ).toBeNull();
  });

  it("resolve returns null if already resolved", async () => {
    await backend.flagRepo.create(makeFlag());
    await backend.flagRepo.resolve("f1", "chris", "accepted");
    expect(
      await backend.flagRepo.resolve("f1", "chris", "accepted"),
    ).toBeNull();
  });

  it("autoResolveByMemoryId sets resolved_by='system' for unresolved flags", async () => {
    await backend.flagRepo.create(makeFlag({ id: "f1" }));
    await backend.flagRepo.create(makeFlag({ id: "f2" }));
    const count = await backend.flagRepo.autoResolveByMemoryId("m1");
    expect(count).toBe(2);
    const after = await backend.flagRepo.findByMemoryId("m1");
    for (const f of after) {
      expect(f.resolved_at).toBeInstanceOf(Date);
      expect(f.resolved_by).toBe("system");
    }
  });

  it("autoResolveByMemoryId skips already-resolved flags", async () => {
    await backend.flagRepo.create(makeFlag({ id: "f1" }));
    await backend.flagRepo.resolve("f1", "chris", "accepted");
    await backend.flagRepo.create(makeFlag({ id: "f2" }));
    const count = await backend.flagRepo.autoResolveByMemoryId("m1");
    expect(count).toBe(1);
  });

  it("autoResolveByMemoryId returns 0 for unknown memory", async () => {
    expect(await backend.flagRepo.autoResolveByMemoryId("nope")).toBe(0);
  });

  it("hasOpenFlag matches type + memory + unresolved state", async () => {
    await backend.flagRepo.create(makeFlag({ flag_type: "duplicate" }));
    expect(await backend.flagRepo.hasOpenFlag("m1", "duplicate")).toBe(true);
    expect(await backend.flagRepo.hasOpenFlag("m1", "contradiction")).toBe(
      false,
    );
    await backend.flagRepo.resolve("f1", "chris", "accepted");
    expect(await backend.flagRepo.hasOpenFlag("m1", "duplicate")).toBe(false);
  });

  it("hasOpenFlag filters by related_memory_id when provided", async () => {
    await backend.flagRepo.create(
      makeFlag({
        flag_type: "duplicate",
        details: { reason: "x", related_memory_id: "m-other" },
      }),
    );
    expect(
      await backend.flagRepo.hasOpenFlag("m1", "duplicate", "m-other"),
    ).toBe(true);
    expect(
      await backend.flagRepo.hasOpenFlag("m1", "duplicate", "m-different"),
    ).toBe(false);
  });

  it("findOpenByWorkspace returns needs_review flags in workspace memories, oldest first", async () => {
    await backend.memoryRepo.create({
      ...makeMemory({ id: "m2", workspace_id: "ws1" }),
      embedding: ZERO_EMB,
    });
    await backend.memoryRepo.create({
      ...makeMemory({ id: "m3", workspace_id: "ws2" }),
      embedding: ZERO_EMB,
    });
    await backend.flagRepo.create(
      makeFlag({
        id: "f1",
        memory_id: "m1",
        created_at: new Date("2026-04-21T10:00:00.000Z"),
      }),
    );
    await backend.flagRepo.create(
      makeFlag({
        id: "f2",
        memory_id: "m2",
        created_at: new Date("2026-04-21T11:00:00.000Z"),
      }),
    );
    // Not in ws1 — should be filtered out.
    await backend.flagRepo.create(
      makeFlag({
        id: "f3",
        memory_id: "m3",
        created_at: new Date("2026-04-21T09:00:00.000Z"),
      }),
    );

    const open = await backend.flagRepo.findOpenByWorkspace("p1", "ws1", 10);
    expect(open.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("findOpenByWorkspace includes project-scoped memories regardless of workspace", async () => {
    await backend.memoryRepo.create({
      ...makeMemory({
        id: "m-proj",
        scope: "project",
        workspace_id: null,
      }),
      embedding: ZERO_EMB,
    });
    await backend.flagRepo.create(makeFlag({ id: "fp", memory_id: "m-proj" }));
    const open = await backend.flagRepo.findOpenByWorkspace("p1", "ws1", 10);
    expect(open.map((f) => f.id)).toContain("fp");
  });

  it("findOpenByWorkspace excludes auto_resolved severity and resolved flags", async () => {
    await backend.flagRepo.create(
      makeFlag({ id: "f-auto", severity: "auto_resolved" }),
    );
    await backend.flagRepo.create(makeFlag({ id: "f-open" }));
    await backend.flagRepo.create(makeFlag({ id: "f-done" }));
    await backend.flagRepo.resolve("f-done", "chris", "accepted");
    const open = await backend.flagRepo.findOpenByWorkspace("p1", "ws1", 10);
    expect(open.map((f) => f.id)).toEqual(["f-open"]);
  });

  it("findOpenByWorkspace respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await backend.flagRepo.create(
        makeFlag({
          id: `f${i}`,
          created_at: new Date(Date.parse("2026-04-21T10:00:00.000Z") + i),
        }),
      );
    }
    const open = await backend.flagRepo.findOpenByWorkspace("p1", "ws1", 3);
    expect(open).toHaveLength(3);
  });
});
