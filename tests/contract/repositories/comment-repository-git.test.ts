import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vaultGitFactory, type TestBackend } from "./_factories.js";
import { commitCount, lastCommitMessage, makeMemory } from "./_git-helpers.js";

describe("CommentRepository git commits — vault", () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await vaultGitFactory.create();
  });

  afterAll(async () => {
    await backend.close();
  });

  it("create produces one commit with AB-Action: commented", async () => {
    const root = backend.gitRoot!;
    await backend.memoryRepo.create(makeMemory("m-comment"));
    const before = await commitCount(root);
    await backend.commentRepo.create({
      id: "c1",
      memory_id: "m-comment",
      author: "alice",
      content: "hi",
    });
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    const msg = await lastCommitMessage(root);
    expect(msg).toContain("AB-Action: commented");
    expect(msg).toContain("AB-Memory: m-comment");
    expect(msg).toContain("AB-Actor: alice");
  });
});
