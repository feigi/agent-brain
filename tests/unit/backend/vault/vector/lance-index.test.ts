import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultVectorIndex } from "../../../../../src/backend/vault/vector/lance-index.js";

describe("VaultVectorIndex — upsert + countRows", () => {
  let root: string;
  let idx: VaultVectorIndex;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lance-test-"));
    idx = await VaultVectorIndex.create({ root, dims: 4 });
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("upserts rows and counts them", async () => {
    await idx.upsert([
      {
        id: "a",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u",
        title: "t",
        archived: false,
        content_hash: "h1",
        vector: [0.1, 0.2, 0.3, 0.4],
      },
    ]);
    expect(await idx.countRows()).toBe(1);
  });

  it("upsert on the same id replaces the previous row", async () => {
    const base = {
      project_id: "p1",
      workspace_id: "ws1",
      scope: "workspace" as const,
      author: "u",
      title: "t",
      archived: false,
      content_hash: "h",
      vector: [0, 0, 0, 0],
    };
    await idx.upsert([{ id: "a", ...base, content_hash: "h1" }]);
    await idx.upsert([{ id: "a", ...base, content_hash: "h2" }]);
    expect(await idx.countRows()).toBe(1);
  });

  it("rejects a vector with the wrong dimension", async () => {
    await expect(
      idx.upsert([
        {
          id: "a",
          project_id: "p1",
          workspace_id: "ws1",
          scope: "workspace",
          author: "u",
          title: "t",
          archived: false,
          content_hash: "h",
          vector: [0, 0, 0],
        },
      ]),
    ).rejects.toThrow(/dimension mismatch/);
  });
});

describe("VaultVectorIndex — search", () => {
  let root: string;
  let idx: VaultVectorIndex;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lance-test-"));
    idx = await VaultVectorIndex.create({ root, dims: 3 });
    await idx.upsert([
      {
        id: "a",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u",
        title: "A",
        archived: false,
        content_hash: "h",
        vector: [1, 0, 0],
      },
      {
        id: "b",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u",
        title: "B",
        archived: false,
        content_hash: "h",
        vector: [0, 1, 0],
      },
      {
        id: "c",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u",
        title: "C",
        archived: true,
        content_hash: "h",
        vector: [1, 0, 0],
      },
    ]);
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("returns rows ordered by cosine similarity, excluding archived", async () => {
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(hits[0].relevance).toBeCloseTo(1, 5);
    expect(hits[1].relevance).toBeCloseTo(0, 5);
  });

  it("respects minSimilarity threshold", async () => {
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0.5,
    });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("returns empty when scope list resolves to no clauses", async () => {
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: null, // workspace scope requested with no ws → skipped
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits).toEqual([]);
  });
});

describe("VaultVectorIndex — findDuplicates", () => {
  let root: string;
  let idx: VaultVectorIndex;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lance-test-"));
    idx = await VaultVectorIndex.create({ root, dims: 3 });
    await idx.upsert([
      {
        id: "a",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u1",
        title: "A",
        archived: false,
        content_hash: "h",
        vector: [1, 0, 0],
      },
      {
        id: "u",
        project_id: "p1",
        workspace_id: null,
        scope: "user",
        author: "u1",
        title: "U",
        archived: false,
        content_hash: "h",
        vector: [1, 0, 0],
      },
    ]);
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("workspace-scope dedup only checks workspace memories", async () => {
    const hits = await idx.findDuplicates({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: "workspace",
      userId: "u1",
      threshold: 0.5,
    });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("user-scope dedup checks both the workspace and user slices (D-16)", async () => {
    const hits = await idx.findDuplicates({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: "user",
      userId: "u1",
      threshold: 0.5,
    });
    // limit(1) — takes whichever ranks first. Any surfaced row must be
    // one of the two near-identical vectors; pg returns the same.
    expect(hits).toHaveLength(1);
    expect(["a", "u"]).toContain(hits[0].id);
  });

  it("below threshold returns empty", async () => {
    const hits = await idx.findDuplicates({
      embedding: [0, 0, 1],
      projectId: "p1",
      workspaceId: "ws1",
      scope: "workspace",
      userId: "u1",
      threshold: 0.9,
    });
    expect(hits).toEqual([]);
  });
});
