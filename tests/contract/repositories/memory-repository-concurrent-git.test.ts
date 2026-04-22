import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vaultGitFactory, type TestBackend } from "./_factories.js";
import { commitCount, makeMemory } from "./_git-helpers.js";
import { simpleGit } from "simple-git";
import { scrubGitEnv } from "../../../src/backend/vault/git/env.js";

describe("MemoryRepository concurrent writers — vault git", () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await vaultGitFactory.create();
  });

  afterAll(async () => {
    await backend.close();
  });

  it("two parallel creates produce two commits, each attributed to the right memory", async () => {
    const root = backend.gitRoot!;
    const before = await commitCount(root);
    await Promise.all([
      backend.memoryRepo.create(makeMemory("c-a")),
      backend.memoryRepo.create(makeMemory("c-b")),
    ]);
    const after = await commitCount(root);
    expect(after - before).toBe(2);

    const log = await simpleGit({ baseDir: root }).env(scrubGitEnv()).log();
    const recent = log.all.slice(0, 2);
    const allTrailers = recent
      .map((c) => `${c.message}\n\n${c.body}`)
      .join("\n---\n");
    // Neither trailer should appear twice, and both should appear once.
    expect((allTrailers.match(/AB-Memory: c-a/g) ?? []).length).toBe(1);
    expect((allTrailers.match(/AB-Memory: c-b/g) ?? []).length).toBe(1);
  });
});
