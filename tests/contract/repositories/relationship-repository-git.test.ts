import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vaultGitFactory, type TestBackend } from "./_factories.js";
import { commitCount, lastCommitMessage, makeMemory } from "./_git-helpers.js";
import type { Relationship } from "../../../src/types/relationship.js";

function makeRelationship(
  id: string,
  sourceId: string,
  targetId: string,
): Relationship {
  return {
    id,
    project_id: "p1",
    source_id: sourceId,
    target_id: targetId,
    type: "refines",
    description: null,
    confidence: 1,
    created_by: "alice",
    created_via: null,
    archived_at: null,
    created_at: new Date("2026-04-22T00:00:00Z"),
  };
}

describe("RelationshipRepository git commits — vault", () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await vaultGitFactory.create();
  });

  afterAll(async () => {
    await backend.close();
  });

  it("create produces one commit with AB-Action: related and AB-Actor: <created_by>", async () => {
    const root = backend.gitRoot!;
    await backend.memoryRepo.create(makeMemory("m-rel-src"));
    await backend.memoryRepo.create(makeMemory("m-rel-tgt"));
    const before = await commitCount(root);
    await backend.relationshipRepo.create(
      makeRelationship("r1", "m-rel-src", "m-rel-tgt"),
    );
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    const msg = await lastCommitMessage(root);
    expect(msg).toContain("AB-Action: related");
    expect(msg).toContain("AB-Memory: m-rel-src");
    expect(msg).toContain("AB-Actor: alice");
  });

  it("archiveById produces one commit with AB-Action: unrelated", async () => {
    const root = backend.gitRoot!;
    await backend.memoryRepo.create(makeMemory("m-rel-src-b"));
    await backend.memoryRepo.create(makeMemory("m-rel-tgt-b"));
    await backend.relationshipRepo.create(
      makeRelationship("r2", "m-rel-src-b", "m-rel-tgt-b"),
    );
    const before = await commitCount(root);
    const ok = await backend.relationshipRepo.archiveById("r2");
    expect(ok).toBe(true);
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    const msg = await lastCommitMessage(root);
    expect(msg).toContain("AB-Action: unrelated");
  });
});
