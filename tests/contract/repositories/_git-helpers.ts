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
