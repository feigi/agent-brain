// tests/unit/backend/vault/watcher/reconciler.test.ts
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createReconciler } from "../../../../../src/backend/vault/watcher/reconciler.js";
import { VaultIndex } from "../../../../../src/backend/vault/repositories/vault-index.js";
import type { IndexRow } from "../../../../../src/backend/vault/vector/lance-index.js";

class StubVectorIndex {
  rows = new Map<
    string,
    { content_hash: string; archived: boolean; vector: number[] }
  >();
  upsertCalls: Array<{ id: string; content_hash: string }> = [];
  upsertMetaOnlyCalls: string[] = [];
  markArchivedCalls: string[] = [];

  async upsert(rows: IndexRow[]): Promise<void> {
    for (const row of rows) {
      this.upsertCalls.push({ id: row.id, content_hash: row.content_hash });
      this.rows.set(row.id, {
        content_hash: row.content_hash,
        archived: false,
        vector: row.vector,
      });
    }
  }
  async upsertMetaOnly(meta: { id: string }): Promise<number> {
    this.upsertMetaOnlyCalls.push(meta.id);
    return 1;
  }
  async getContentHash(id: string): Promise<string | null> {
    return this.rows.get(id)?.content_hash ?? null;
  }
  async markArchived(id: string): Promise<number> {
    this.markArchivedCalls.push(id);
    const row = this.rows.get(id);
    if (row) row.archived = true;
    return row ? 1 : 0;
  }
}

class StubFlagService {
  createCalls: Array<{ memoryId: string; flagType: string; reason: string }> =
    [];
  resolveCalls: string[] = [];
  openFlags = new Map<string, Array<{ id: string; flag_type: string }>>();

  async hasOpenFlag(memoryId: string, flagType: string): Promise<boolean> {
    return (this.openFlags.get(memoryId) ?? []).some(
      (f) => f.flag_type === flagType,
    );
  }
  async createFlag(input: {
    memoryId: string;
    flagType: string;
    severity: string;
    details: { reason: string };
  }) {
    this.createCalls.push({
      memoryId: input.memoryId,
      flagType: input.flagType,
      reason: input.details.reason,
    });
    return { id: `flag-${this.createCalls.length}` };
  }
  async getFlagsByMemoryId(memoryId: string) {
    return this.openFlags.get(memoryId) ?? [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async resolveFlag(flagId: string, ..._args: unknown[]) {
    this.resolveCalls.push(flagId);
    return { id: flagId };
  }
}

const sha256Hex = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");

const stubEmbed = async (text: string): Promise<number[]> => {
  const seed = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);
  return [seed % 100, (seed * 7) % 100, (seed * 13) % 100, (seed * 17) % 100];
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ab-reconciler-"));
  await mkdir(join(root, "workspaces", "ws"), { recursive: true });
  const vaultIndex = await VaultIndex.create(root);
  const vectorIndex = new StubVectorIndex();
  const flagService = new StubFlagService();
  const reconciler = createReconciler({
    vaultIndex,
    vectorIndex: vectorIndex as unknown as Parameters<
      typeof createReconciler
    >[0]["vectorIndex"],
    flagService: flagService as unknown as Parameters<
      typeof createReconciler
    >[0]["flagService"],
    embed: stubEmbed,
    vaultRoot: root,
  });
  return { root, vaultIndex, vectorIndex, flagService, reconciler };
}

const VALID_MD = `---
id: mem-1
title: Test memory
type: pattern
scope: workspace
workspace_id: ws
project_id: proj
author: alice
source: agent-auto
session_id: null
tags: null
version: 1
created: '2026-04-25T00:00:00.000Z'
updated: '2026-04-25T00:00:00.000Z'
verified: null
verified_by: null
archived: null
embedding_model: stub
embedding_dimensions: 4
metadata: null
flags: []
---
# Test memory

Body content.
`;

describe("reconciler.reconcileFile add (new row)", () => {
  it("indexes a new file: parse → embed → vectorIndex.upsert → vaultIndex.register", async () => {
    const { root, vaultIndex, vectorIndex, flagService, reconciler } =
      await setup();
    try {
      const dir = join(root, "workspaces/ws/memories");
      await mkdir(dir, { recursive: true });
      const abs = join(dir, "mem-1.md");
      await writeFile(abs, VALID_MD);

      const result = await reconciler.reconcileFile(abs, "add");

      expect(result.action).toBe("indexed");
      expect(result.memoryId).toBe("mem-1");
      expect(vectorIndex.upsertCalls).toHaveLength(1);
      expect(vectorIndex.upsertCalls[0].id).toBe("mem-1");
      expect(vaultIndex.has("mem-1")).toBe(true);
      expect(vaultIndex.get("mem-1")?.path).toBe(
        "workspaces/ws/memories/mem-1.md",
      );
      expect(flagService.createCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// sha256Hex is defined above; suppress unused warning via reference in test
void sha256Hex;

describe("reconciler.reconcileFile change (existing row)", () => {
  it("hash matches + frontmatter unchanged → skipped", async () => {
    const { root, vaultIndex, vectorIndex, reconciler } = await setup();
    try {
      const dir = join(root, "workspaces/ws/memories");
      await mkdir(dir, { recursive: true });
      const abs = join(dir, "mem-1.md");
      await writeFile(abs, VALID_MD);

      // First call: indexes the file (this populates VaultIndex with the canonical entry).
      await reconciler.reconcileFile(abs, "add");
      vectorIndex.upsertCalls = []; // reset so we only count change-branch calls

      // Now the change event with body unchanged.
      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("skipped");
      expect(result.memoryId).toBe("mem-1");
      expect(vectorIndex.upsertCalls).toHaveLength(0);
      expect(vectorIndex.upsertMetaOnlyCalls).toHaveLength(0);
      expect(vaultIndex.has("mem-1")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hash matches but frontmatter changed → upsertMetaOnly", async () => {
    const { root, vaultIndex, vectorIndex, reconciler } = await setup();
    try {
      const dir = join(root, "workspaces/ws/memories");
      await mkdir(dir, { recursive: true });
      const abs = join(dir, "mem-1.md");

      // Seed the index by indexing the original file.
      await writeFile(abs, VALID_MD);
      await reconciler.reconcileFile(abs, "add");
      vectorIndex.upsertCalls = [];

      // Rewrite file with a changed title (frontmatter + H1 must both flip — parser
      // requires title-in-frontmatter to equal H1 in body).
      const renamed = VALID_MD.replace(
        "title: Test memory",
        "title: Renamed memory",
      ).replace("# Test memory", "# Renamed memory");
      await writeFile(abs, renamed);

      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("meta-updated");
      expect(result.memoryId).toBe("mem-1");
      expect(vectorIndex.upsertCalls).toHaveLength(0);
      expect(vectorIndex.upsertMetaOnlyCalls).toEqual(["mem-1"]);
      expect(vaultIndex.has("mem-1")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hash differs → re-embed + upsert", async () => {
    const { root, vectorIndex, reconciler } = await setup();
    try {
      const dir = join(root, "workspaces/ws/memories");
      await mkdir(dir, { recursive: true });
      const abs = join(dir, "mem-1.md");

      await writeFile(abs, VALID_MD);
      await reconciler.reconcileFile(abs, "add");
      vectorIndex.upsertCalls = [];

      // Rewrite body content (and re-render H1 to keep parser happy).
      const newBody = VALID_MD.replace(
        "Body content.",
        "Brand new body text here.",
      );
      await writeFile(abs, newBody);

      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("reembedded");
      expect(result.memoryId).toBe("mem-1");
      expect(vectorIndex.upsertCalls).toHaveLength(1);
      expect(vectorIndex.upsertCalls[0].id).toBe("mem-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const BROKEN_FRONTMATTER_MD = `---
this is not yaml: at all: ":
title:
---

body
`;

// Reuse VALID_MD's working frontmatter, then corrupt only the body (no H1).
const VALID_FM_BROKEN_BODY_MD = VALID_MD.replace(
  "# Test memory\n\nBody content.\n",
  "(no body heading — splitBody throws)\n",
);

describe("reconciler.reconcileFile parse failures", () => {
  it("frontmatter broken + path NOT in index → vaultIndex.setUnindexable", async () => {
    const { root, vaultIndex, flagService, reconciler } = await setup();
    try {
      const dir = join(root, "workspaces/ws/memories");
      await mkdir(dir, { recursive: true });
      const abs = join(dir, "broken.md");
      await writeFile(abs, BROKEN_FRONTMATTER_MD);

      const result = await reconciler.reconcileFile(abs, "add");

      expect(result.action).toBe("parse-error");
      expect(flagService.createCalls).toHaveLength(0);
      expect(
        vaultIndex.unindexable.find(
          (u) => u.path === "workspaces/ws/memories/broken.md",
        ),
      ).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("body broken + id resolvable + no existing flag → flagService.createFlag", async () => {
    const { root, vaultIndex, flagService, reconciler } = await setup();
    try {
      const dir = join(root, "workspaces/ws/memories");
      await mkdir(dir, { recursive: true });
      const abs = join(dir, "mem-1.md");
      await writeFile(abs, VALID_FM_BROKEN_BODY_MD);

      // Pre-register the path so the id-by-path lookup works.
      vaultIndex.register("mem-1", {
        path: "workspaces/ws/memories/mem-1.md",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
      });

      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("parse-error");
      expect(result.memoryId).toBe("mem-1");
      expect(flagService.createCalls).toHaveLength(1);
      expect(flagService.createCalls[0].memoryId).toBe("mem-1");
      expect(flagService.createCalls[0].flagType).toBe("parse_error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parse failure + id resolvable + flag already open → no duplicate flag", async () => {
    const { root, vaultIndex, flagService, reconciler } = await setup();
    try {
      const dir = join(root, "workspaces/ws/memories");
      await mkdir(dir, { recursive: true });
      const abs = join(dir, "mem-1.md");
      await writeFile(abs, VALID_FM_BROKEN_BODY_MD);
      vaultIndex.register("mem-1", {
        path: "workspaces/ws/memories/mem-1.md",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
      });
      flagService.openFlags.set("mem-1", [
        { id: "existing", flag_type: "parse_error" },
      ]);

      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("parse-error");
      expect(flagService.createCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parse passes after prior unindexable entry → clearUnindexable + auto-resolve flags", async () => {
    const { root, vaultIndex, flagService, reconciler } = await setup();
    try {
      const dir = join(root, "workspaces/ws/memories");
      await mkdir(dir, { recursive: true });
      const abs = join(dir, "mem-1.md");
      await writeFile(abs, VALID_MD);

      // Seed a stale unindexable entry that should be cleared on success.
      vaultIndex.setUnindexable(
        "workspaces/ws/memories/mem-1.md",
        "previously broken",
      );
      // Seed an open parse_error flag that should auto-resolve.
      flagService.openFlags.set("mem-1", [
        { id: "old-pe", flag_type: "parse_error" },
      ]);

      const result = await reconciler.reconcileFile(abs, "add");

      expect(result.action).toBe("indexed");
      expect(
        vaultIndex.unindexable.find(
          (u) => u.path === "workspaces/ws/memories/mem-1.md",
        ),
      ).toBeUndefined();
      expect(flagService.resolveCalls).toEqual(["old-pe"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("reconciler.reconcileFile unlink", () => {
  it("known path → markArchived lance + unregister vault index + resolve open parse_error flags", async () => {
    const { root, vaultIndex, vectorIndex, flagService, reconciler } =
      await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/mem-1.md");
      vaultIndex.register("mem-1", {
        path: "workspaces/ws/memories/mem-1.md",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
      });
      vectorIndex.rows.set("mem-1", {
        content_hash: "h",
        archived: false,
        vector: [1, 1, 1, 1],
      });
      flagService.openFlags.set("mem-1", [
        { id: "f1", flag_type: "parse_error" },
        { id: "f2", flag_type: "duplicate" },
      ]);

      const result = await reconciler.reconcileFile(abs, "unlink");

      expect(result.action).toBe("archived");
      expect(result.memoryId).toBe("mem-1");
      expect(vectorIndex.markArchivedCalls).toEqual(["mem-1"]);
      expect(vaultIndex.has("mem-1")).toBe(false);
      expect(flagService.resolveCalls).toEqual(["f1"]); // only the parse_error flag
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unknown path (orphan unlink) → no-op skipped", async () => {
    const { root, vectorIndex, flagService, reconciler } = await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/missing.md");
      const result = await reconciler.reconcileFile(abs, "unlink");
      expect(result.action).toBe("skipped");
      expect(vectorIndex.markArchivedCalls).toHaveLength(0);
      expect(flagService.resolveCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
