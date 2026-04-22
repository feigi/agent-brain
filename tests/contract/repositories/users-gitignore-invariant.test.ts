import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vaultGitFactory, type TestBackend } from "./_factories.js";
import { DomainError } from "../../../src/utils/errors.js";
import { commitCount } from "./_git-helpers.js";
import type { Memory } from "../../../src/types/memory.js";

function makeUserScoped(id: string): Memory & { embedding: number[] } {
  const now = new Date("2026-04-22T00:00:00Z");
  return {
    id,
    project_id: "p1",
    workspace_id: "ws1",
    scope: "user",
    content: "private",
    title: `u-${id}`,
    type: "fact",
    tags: null,
    author: "alice",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: null,
    embedding_dimensions: 768,
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
    embedding: new Array(768).fill(0.1),
  };
}

describe("users-gitignore invariant — vault", () => {
  it("refuses user-scope create when users/ rule is removed", async () => {
    const backend: TestBackend = await vaultGitFactory.create();
    try {
      const path = join(backend.gitRoot!, ".gitignore");
      const body = await readFile(path, "utf8");
      await writeFile(
        path,
        body
          .split("\n")
          .filter((l) => l.trim() !== "users/")
          .join("\n"),
        "utf8",
      );
      await expect(
        backend.memoryRepo.create(makeUserScoped("m-u1")),
      ).rejects.toThrow(DomainError);
    } finally {
      await backend.close();
    }
  });

  it("user-scope create with trackUsersInGit=false writes markdown + lance but no commit", async () => {
    const backend: TestBackend = await vaultGitFactory.create();
    try {
      const root = backend.gitRoot!;
      const before = await commitCount(root);
      const mem = await backend.memoryRepo.create(makeUserScoped("m-u2"));
      expect(mem.id).toBe("m-u2");
      const after = await commitCount(root);
      expect(after - before).toBe(0);
      expect(await backend.memoryRepo.findById("m-u2")).not.toBeNull();
    } finally {
      await backend.close();
    }
  });
});
