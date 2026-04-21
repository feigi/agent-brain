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
