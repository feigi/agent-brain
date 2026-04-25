import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend } from "../../src/backend/factory.js";
import type { StorageBackend } from "../../src/backend/types.js";
import type { Memory } from "../../src/types/memory.js";
import type { Flag } from "../../src/types/flag.js";
import type { Relationship } from "../../src/types/relationship.js";
import { truncateAll } from "../helpers.js";
import { TEST_DB_URL } from "../global-setup.js";

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
    details: { reason: "r" },
    resolved_at: null,
    resolved_by: null,
    created_at: new Date("2026-04-21T10:00:00.000Z"),
    ...overrides,
  };
}

function makeRel(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: "r1",
    project_id: "p1",
    source_id: "m1",
    target_id: "m2",
    type: "refines",
    description: null,
    confidence: 0.9,
    created_by: "chris",
    created_via: null,
    archived_at: null,
    created_at: new Date("2026-04-21T10:00:00.000Z"),
    ...overrides,
  };
}

interface BackendCase {
  name: "postgres" | "vault";
  setup(): Promise<{ backend: StorageBackend; teardown: () => Promise<void> }>;
}

const cases: BackendCase[] = [
  {
    name: "postgres",
    async setup() {
      // Truncate via the shared test-DB pool; createBackend spins up its
      // own pool (closed in teardown) so it doesn't race with other tests.
      await truncateAll();
      const backend = await createBackend({
        backend: "postgres",
        databaseUrl: TEST_DB_URL,
        vaultRoot: "",
        embeddingDimensions: 768,
        projectId: "test-project",
      });
      return {
        backend,
        teardown: async () => {
          await backend.close();
        },
      };
    },
  },
  {
    name: "vault",
    async setup() {
      const root = await mkdtemp(join(tmpdir(), "backend-factory-"));
      const backend = await createBackend({
        backend: "vault",
        databaseUrl: "",
        vaultRoot: root,
        embeddingDimensions: 768,
        projectId: "test-project",
      });
      return {
        backend,
        teardown: async () => {
          await backend.close();
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  },
];

describe.each(cases)("StorageBackend assembly — $name", (c) => {
  let backend: StorageBackend;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ backend, teardown } = await c.setup());
  });
  afterEach(async () => {
    await teardown();
  });

  it("exposes name matching the requested backend", () => {
    expect(backend.name).toBe(c.name);
  });

  it("composes all nine repositories", () => {
    expect(backend.memoryRepo).toBeDefined();
    expect(backend.workspaceRepo).toBeDefined();
    expect(backend.commentRepo).toBeDefined();
    expect(backend.sessionRepo).toBeDefined();
    expect(backend.sessionLifecycleRepo).toBeDefined();
    expect(backend.auditRepo).toBeDefined();
    expect(backend.flagRepo).toBeDefined();
    expect(backend.relationshipRepo).toBeDefined();
    expect(backend.schedulerStateRepo).toBeDefined();
  });

  it("runs an end-to-end cross-repo scenario", async () => {
    await backend.workspaceRepo.findOrCreate("ws1");
    await backend.memoryRepo.create({ ...makeMemory(), embedding: ZERO_EMB });
    await backend.memoryRepo.create({
      ...makeMemory({ id: "m2" }),
      embedding: ZERO_EMB,
    });

    await backend.commentRepo.create({
      id: "c1",
      memory_id: "m1",
      author: "chris",
      content: "hello",
    });
    expect(await backend.commentRepo.countByMemoryId("m1")).toBe(1);

    await backend.flagRepo.create(makeFlag());
    expect(await backend.flagRepo.hasOpenFlag("m1", "duplicate")).toBe(true);
    const resolved = await backend.flagRepo.resolve("f1", "chris", "accepted");
    expect(resolved?.resolved_by).toBe("chris");
    expect(await backend.flagRepo.hasOpenFlag("m1", "duplicate")).toBe(false);

    await backend.relationshipRepo.create(makeRel());
    const rel = await backend.relationshipRepo.findById("r1");
    expect(rel?.target_id).toBe("m2");

    await backend.auditRepo.create({
      id: "a1",
      project_id: "p1",
      memory_id: "m1",
      action: "created",
      actor: "chris",
      reason: null,
      diff: null,
      created_at: new Date("2026-04-21T10:00:00.000Z"),
    });
    const audits = await backend.auditRepo.findByMemoryId("m1");
    if (c.name === "vault") {
      // Under vault, findByMemoryId reads git log — every mutation that touched
      // m1 via a repo that commits (memory create, comment, flag) appears as an
      // entry. The explicit create() above is a no-op. We assert the audit log
      // reflects the real mutation history, not just the explicit create.
      // Actions that don't map through TRAILER_TO_AUDIT (unflagged, related)
      // are filtered out, so only created/commented/flagged surface.
      const actions = audits.map((a) => a.action).sort();
      expect(actions).toEqual(["commented", "created", "flagged"]);
    } else {
      expect(audits).toHaveLength(1);
    }

    const now = new Date("2026-04-21T11:00:00.000Z");
    await backend.schedulerStateRepo.recordRun("consolidation", now);
    expect(
      (await backend.schedulerStateRepo.getLastRun("consolidation"))?.getTime(),
    ).toBe(now.getTime());

    const prev = await backend.sessionRepo.upsert("u1", "p1", "ws1");
    expect(prev).toBeNull();
    const second = await backend.sessionRepo.upsert("u1", "p1", "ws1");
    expect(second).toBeInstanceOf(Date);
  });

  it("sessionStart returns empty meta", async () => {
    const meta = await backend.sessionStart();
    expect(meta).toEqual({});
  });
});
