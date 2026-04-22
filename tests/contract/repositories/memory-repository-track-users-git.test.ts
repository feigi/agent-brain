import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeVaultGitFactory, type TestBackend } from "./_factories.js";
import { commitCount, lastCommitMessage, makeMemory } from "./_git-helpers.js";
import type { Memory, MemoryScope } from "../../../src/types/memory.js";

function makeUserScoped(id: string): Memory & { embedding: number[] } {
  return {
    ...makeMemory(id, "user" as MemoryScope),
    content: `private-${id}`,
  };
}

describe("MemoryRepository user-scope commits with trackUsersInGit=true — vault", () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await makeVaultGitFactory({ trackUsersInGit: true }).create();
  });

  afterAll(async () => {
    await backend.close();
  });

  it("does not list users/ in .gitignore when trackUsersInGit=true", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const body = await readFile(join(backend.gitRoot!, ".gitignore"), "utf8");
    expect(body.split("\n").map((l) => l.trim())).not.toContain("users/");
  });

  it("user-scope create produces one commit with AB-Action: created", async () => {
    const root = backend.gitRoot!;
    const before = await commitCount(root);
    await backend.memoryRepo.create(makeUserScoped("m-u-track"));
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    const msg = await lastCommitMessage(root);
    expect(msg).toContain("AB-Action: created");
    expect(msg).toContain("AB-Memory: m-u-track");
  });

  it("user-scope comment produces one commit with AB-Action: commented", async () => {
    const root = backend.gitRoot!;
    const before = await commitCount(root);
    await backend.commentRepo.create({
      id: "c-u1",
      memory_id: "m-u-track",
      author: "alice",
      content: "note",
    });
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    expect(await lastCommitMessage(root)).toContain("AB-Action: commented");
  });
});
