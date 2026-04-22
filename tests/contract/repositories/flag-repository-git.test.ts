import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vaultGitFactory, type TestBackend } from "./_factories.js";
import { commitCount, lastCommitMessage, makeMemory } from "./_git-helpers.js";
import type { Flag } from "../../../src/types/flag.js";

function makeFlag(id: string, memoryId: string): Flag {
  return {
    id,
    project_id: "p1",
    memory_id: memoryId,
    flag_type: "duplicate",
    severity: "needs_review",
    details: { reason: "test" },
    resolved_at: null,
    resolved_by: null,
    created_at: new Date("2026-04-22T00:00:00Z"),
  };
}

describe("FlagRepository git commits — vault", () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await vaultGitFactory.create();
  });

  afterAll(async () => {
    await backend.close();
  });

  it("create produces one commit with AB-Action: flagged and AB-Actor: system", async () => {
    const root = backend.gitRoot!;
    await backend.memoryRepo.create(makeMemory("m-flag"));
    const before = await commitCount(root);
    await backend.flagRepo.create(makeFlag("f1", "m-flag"));
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    const msg = await lastCommitMessage(root);
    expect(msg).toContain("AB-Action: flagged");
    expect(msg).toContain("AB-Memory: m-flag");
    expect(msg).toContain("AB-Actor: system");
  });

  it("resolve produces one commit with AB-Action: unflagged and AB-Actor: <resolver>", async () => {
    const root = backend.gitRoot!;
    await backend.memoryRepo.create(makeMemory("m-flag-res"));
    await backend.flagRepo.create(makeFlag("f2", "m-flag-res"));
    const before = await commitCount(root);
    const resolved = await backend.flagRepo.resolve("f2", "bob", "accepted");
    expect(resolved).not.toBeNull();
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    const msg = await lastCommitMessage(root);
    expect(msg).toContain("AB-Action: unflagged");
    expect(msg).toContain("AB-Actor: bob");
  });
});
