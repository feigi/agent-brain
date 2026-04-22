import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";
import { GitOpsImpl } from "../../../../../src/backend/vault/git/git-ops.js";
import { reconcileDirty } from "../../../../../src/backend/vault/git/reconcile.js";

async function makeRepo(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "reconcile-test-"));
  const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
  await git.init();
  await git.addConfig("user.email", "t@x", false, "local");
  await git.addConfig("user.name", "t", false, "local");
  // Ignore a runtime subtree to prove reconcile skips gitignored files.
  await writeFile(join(root, ".gitignore"), ".agent-brain/\n");
  await git.add(".gitignore");
  await git.commit("init");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("reconcileDirty", () => {
  it("collapses dirty tracked memory markdown into one reconcile commit", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      const ops = new GitOpsImpl({ root });

      // Create + commit two memory files so they're tracked.
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(join(root, "workspaces/ws1/memories/a.md"), "v1-a\n");
      await writeFile(join(root, "workspaces/ws1/memories/b.md"), "v1-b\n");
      await git.add([
        "workspaces/ws1/memories/a.md",
        "workspaces/ws1/memories/b.md",
      ]);
      await git.commit("seed");

      // Now dirty them outside git — simulates post-crash state.
      await writeFile(join(root, "workspaces/ws1/memories/a.md"), "v2-a\n");
      await writeFile(join(root, "workspaces/ws1/memories/b.md"), "v2-b\n");

      await reconcileDirty({ git, ops });

      const log = await git.log();
      expect(log.latest?.message).toMatch(/reconcile/i);
      const showFiles = await git.raw([
        "show",
        "--name-only",
        "--pretty=format:",
        "HEAD",
      ]);
      const files = showFiles
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(files).toEqual(
        expect.arrayContaining([
          "workspaces/ws1/memories/a.md",
          "workspaces/ws1/memories/b.md",
        ]),
      );
    } finally {
      await cleanup();
    }
  });

  it("no-op when tree clean", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      const ops = new GitOpsImpl({ root });
      const before = (await git.log()).total;
      await reconcileDirty({ git, ops });
      const after = (await git.log()).total;
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it("includes tracked deletions in reconcile commit", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      const ops = new GitOpsImpl({ root });

      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(join(root, "workspaces/ws1/memories/gone.md"), "v1\n");
      await git.add("workspaces/ws1/memories/gone.md");
      await git.commit("seed");

      await unlink(join(root, "workspaces/ws1/memories/gone.md"));

      const result = await reconcileDirty({ git, ops });
      expect(result.failed).toBe(false);

      const log = await git.log();
      expect(log.latest?.message).toMatch(/reconcile/i);
      // File should no longer be in the tree at HEAD.
      const lsTree = await git.raw(["ls-tree", "-r", "--name-only", "HEAD"]);
      expect(lsTree).not.toMatch(/gone\.md/);
    } finally {
      await cleanup();
    }
  });

  it("collapses dirty memory markdown across workspace, project, and user scopes", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      const ops = new GitOpsImpl({ root });

      // Seed one memory of each scope.
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await mkdir(join(root, "project/memories"), { recursive: true });
      await mkdir(join(root, "users/alice/ws1"), { recursive: true });
      await writeFile(join(root, "workspaces/ws1/memories/w.md"), "v1\n");
      await writeFile(join(root, "project/memories/p.md"), "v1\n");
      await writeFile(join(root, "users/alice/ws1/u.md"), "v1\n");
      await git.add([
        "workspaces/ws1/memories/w.md",
        "project/memories/p.md",
        "users/alice/ws1/u.md",
      ]);
      await git.commit("seed");

      // Dirty all three.
      await writeFile(join(root, "workspaces/ws1/memories/w.md"), "v2\n");
      await writeFile(join(root, "project/memories/p.md"), "v2\n");
      await writeFile(join(root, "users/alice/ws1/u.md"), "v2\n");

      await reconcileDirty({ git, ops });

      const showFiles = await git.raw([
        "show",
        "--name-only",
        "--pretty=format:",
        "HEAD",
      ]);
      const files = showFiles
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(files).toEqual(
        expect.arrayContaining([
          "workspaces/ws1/memories/w.md",
          "project/memories/p.md",
          "users/alice/ws1/u.md",
        ]),
      );
    } finally {
      await cleanup();
    }
  });

  it("ignores untracked files and gitignored dirty files", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      const ops = new GitOpsImpl({ root });

      await mkdir(join(root, ".agent-brain"), { recursive: true });
      await writeFile(join(root, ".agent-brain/state.json"), "{}");
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/new.md"),
        "untracked\n",
      );

      const before = (await git.log()).total;
      await reconcileDirty({ git, ops });
      const after = (await git.log()).total;
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });
});
