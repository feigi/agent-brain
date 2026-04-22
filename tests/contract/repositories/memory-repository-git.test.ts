import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { simpleGit } from "simple-git";
import { vaultGitFactory, type TestBackend } from "./_factories.js";
import { scrubGitEnv } from "../../../src/backend/vault/git/env.js";
import type { Memory, MemoryScope } from "../../../src/types/memory.js";

function makeMemory(
  id: string,
  scope: MemoryScope = "workspace",
): Memory & { embedding: number[] } {
  const now = new Date("2026-04-22T00:00:00Z");
  return {
    id,
    project_id: "p1",
    workspace_id: scope === "project" ? null : "ws1",
    content: `body-${id}`,
    title: `t-${id}`,
    type: "fact",
    scope,
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

async function commitCount(root: string): Promise<number> {
  try {
    const log = await simpleGit({ baseDir: root }).env(scrubGitEnv()).log();
    return log.total;
  } catch {
    return 0;
  }
}

async function lastCommitMessage(root: string): Promise<string> {
  const log = await simpleGit({ baseDir: root }).env(scrubGitEnv()).log();
  return `${log.latest?.message ?? ""}\n\n${log.latest?.body ?? ""}`;
}

describe("MemoryRepository git commits — vault", () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await vaultGitFactory.create();
  });

  afterAll(async () => {
    await backend.close();
  });

  it("create produces one commit with AB-Action: created", async () => {
    const root = backend.gitRoot!;
    const before = await commitCount(root);
    await backend.memoryRepo.create(makeMemory("m-create"));
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    const msg = await lastCommitMessage(root);
    expect(msg).toContain("AB-Action: created");
    expect(msg).toContain("AB-Memory: m-create");
    expect(msg).toContain("AB-Actor: alice");
  });

  it("update produces one commit with AB-Action: updated", async () => {
    const root = backend.gitRoot!;
    const before = await commitCount(root);
    await backend.memoryRepo.update("m-create", 1, { content: "new body" });
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    expect(await lastCommitMessage(root)).toContain("AB-Action: updated");
  });

  it("archive produces one commit per archived id", async () => {
    const root = backend.gitRoot!;
    await backend.memoryRepo.create(makeMemory("m-arc-a"));
    await backend.memoryRepo.create(makeMemory("m-arc-b"));
    const before = await commitCount(root);
    const n = await backend.memoryRepo.archive(["m-arc-a", "m-arc-b"]);
    expect(n).toBe(2);
    const after = await commitCount(root);
    expect(after - before).toBe(2);
  });

  it("verify produces one commit with AB-Action: verified and AB-Actor: <verifier>", async () => {
    const root = backend.gitRoot!;
    await backend.memoryRepo.create(makeMemory("m-verify"));
    const before = await commitCount(root);
    await backend.memoryRepo.verify("m-verify", "reviewer-bob");
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    const msg = await lastCommitMessage(root);
    expect(msg).toContain("AB-Action: verified");
    expect(msg).toContain("AB-Actor: reviewer-bob");
  });
});
