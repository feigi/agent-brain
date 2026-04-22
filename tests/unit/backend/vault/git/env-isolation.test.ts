import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { GitOpsImpl } from "../../../../../src/backend/vault/git/git-ops.js";
import { ensureVaultGit } from "../../../../../src/backend/vault/git/bootstrap.js";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";

// Regression: when GIT_DIR / GIT_WORK_TREE are set in the process env
// (husky hooks, parent git commands, editor plugins), they silently
// override simple-git's baseDir. Without scrubbing, every vault git op
// writes to the outer repo instead of the vault root. Guard both
// GitOpsImpl and ensureVaultGit.
describe("vault/git: env isolation under GIT_DIR / GIT_WORK_TREE", () => {
  let root: string;
  let outer: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-env-"));
    outer = await mkdtemp(join(tmpdir(), "outer-"));
    await simpleGit(outer).env(scrubGitEnv()).init();
    saved.GIT_DIR = process.env.GIT_DIR;
    saved.GIT_WORK_TREE = process.env.GIT_WORK_TREE;
    saved.GIT_INDEX_FILE = process.env.GIT_INDEX_FILE;
    process.env.GIT_DIR = join(outer, ".git");
    process.env.GIT_WORK_TREE = outer;
    delete process.env.GIT_INDEX_FILE;
  });

  afterEach(async () => {
    if (saved.GIT_DIR === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.GIT_DIR;
    if (saved.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = saved.GIT_WORK_TREE;
    if (saved.GIT_INDEX_FILE === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = saved.GIT_INDEX_FILE;
    await rm(root, { recursive: true, force: true });
    await rm(outer, { recursive: true, force: true });
  });

  it("GitOpsImpl commits to cfg.root, not the outer repo targeted by GIT_DIR", async () => {
    const ops = new GitOpsImpl({ root });
    await ops.init();
    const inner = simpleGit(root).env(scrubGitEnv());
    await inner.addConfig("user.email", "t@t");
    await inner.addConfig("user.name", "t");
    await writeFile(join(root, "a.md"), "x", "utf8");
    await ops.stageAndCommit(["a.md"], "s", {
      action: "created",
      memoryId: "abc",
      actor: "alice",
    });
    const innerLog = await simpleGit(root).env(scrubGitEnv()).log();
    expect(innerLog.total).toBe(1);
    expect(await commitCount(outer)).toBe(0);
  });

  async function commitCount(dir: string): Promise<number> {
    try {
      const log = await simpleGit(dir).env(scrubGitEnv()).log();
      return log.total;
    } catch {
      return 0;
    }
  }

  it("ensureVaultGit initializes cfg.root, not the outer repo", async () => {
    await ensureVaultGit({ root, trackUsers: false });
    expect(await commitCount(root)).toBe(0);
    expect(await simpleGit(root).env(scrubGitEnv()).checkIsRepo()).toBe(true);
  });
});
