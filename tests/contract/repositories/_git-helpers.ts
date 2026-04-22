import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { scrubGitEnv } from "../../../src/backend/vault/git/env.js";
import type { Memory, MemoryScope } from "../../../src/types/memory.js";

export function makeMemory(
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

export async function commitCount(root: string): Promise<number> {
  try {
    const log = await simpleGit({ baseDir: root }).env(scrubGitEnv()).log();
    return log.total;
  } catch {
    return 0;
  }
}

export async function lastCommitMessage(root: string): Promise<string> {
  const log = await simpleGit({ baseDir: root }).env(scrubGitEnv()).log();
  return `${log.latest?.message ?? ""}\n\n${log.latest?.body ?? ""}`;
}

export async function setupBareAndTwoVaults(): Promise<{
  dir: string;
  bare: string;
  vaultA: string;
  vaultB: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "two-clone-"));
  const bare = join(dir, "origin.git");
  await mkdir(bare, { recursive: true });
  await simpleGit().env(scrubGitEnv()).cwd(bare).init(true);
  // Pin bare HEAD to `main` so CI (no init.defaultBranch) matches local.
  await simpleGit()
    .env(scrubGitEnv())
    .cwd(bare)
    .raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const vaultA = join(dir, "a");
  const vaultB = join(dir, "b");
  return {
    dir,
    bare,
    vaultA,
    vaultB,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
