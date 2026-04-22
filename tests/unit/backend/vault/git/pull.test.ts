import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";
import { syncFromRemote } from "../../../../../src/backend/vault/git/pull.js";

async function setupOriginAndClone(): Promise<{
  origin: string;
  clone: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pull-test-"));
  const origin = join(dir, "origin.git");
  const clone = join(dir, "clone");
  await mkdir(origin);
  await simpleGit().env(scrubGitEnv()).cwd(origin).init(true);
  // Force bare HEAD to `main` so environments without init.defaultBranch=main
  // (e.g. CI) don't leave HEAD pointing at a nonexistent `master` ref, which
  // breaks subsequent clones and non-ff pushes.
  await simpleGit()
    .env(scrubGitEnv())
    .cwd(origin)
    .raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  await simpleGit().env(scrubGitEnv()).clone(origin, clone);
  const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
  await git.addConfig("user.email", "t@x", false, "local");
  await git.addConfig("user.name", "t", false, "local");
  await writeFile(join(clone, "first.md"), "hello\n");
  await git.add("first.md");
  await git.commit("initial");
  await git.push("origin", "HEAD:main");
  return {
    origin,
    clone,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("syncFromRemote", () => {
  it("fast-forward returns changedPaths, not offline/conflict", async () => {
    const { origin, clone, cleanup } = await setupOriginAndClone();
    try {
      // Make a second clone, commit, push.
      const other = clone + "-other";
      await simpleGit().env(scrubGitEnv()).clone(origin, other);
      const og = simpleGit({ baseDir: other }).env(scrubGitEnv());
      await og.addConfig("user.email", "t@x", false, "local");
      await og.addConfig("user.name", "t", false, "local");
      await writeFile(join(other, "added.md"), "new\n");
      await og.add("added.md");
      await og.commit("add file");
      await og.push("origin", "HEAD:main");

      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      const result = await syncFromRemote({ git });
      expect(result.offline).toBe(false);
      expect(result.conflict).toBe(false);
      expect(result.changedPaths).toContain("added.md");
    } finally {
      await cleanup();
    }
  });

  it("up-to-date returns empty changedPaths", async () => {
    const { clone, cleanup } = await setupOriginAndClone();
    try {
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      const result = await syncFromRemote({ git });
      expect(result.offline).toBe(false);
      expect(result.conflict).toBe(false);
      expect(result.changedPaths).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("rebase conflict → conflict=true, rebase aborted, working tree clean", async () => {
    const { origin, clone, cleanup } = await setupOriginAndClone();
    try {
      // Remote commit modifies first.md.
      const other = clone + "-other";
      await simpleGit().env(scrubGitEnv()).clone(origin, other);
      const og = simpleGit({ baseDir: other }).env(scrubGitEnv());
      await og.addConfig("user.email", "t@x", false, "local");
      await og.addConfig("user.name", "t", false, "local");
      await writeFile(join(other, "first.md"), "remote-change\n");
      await og.add("first.md");
      await og.commit("remote");
      await og.push("origin", "HEAD:main");

      // Local conflicting commit on the same file.
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      await writeFile(join(clone, "first.md"), "local-change\n");
      await git.add("first.md");
      await git.commit("local");

      const result = await syncFromRemote({ git });
      expect(result.conflict).toBe(true);
      expect(result.offline).toBe(false);
      const status = await git.status();
      expect(status.files).toHaveLength(0); // clean working tree
    } finally {
      await cleanup();
    }
  });

  it("network failure → offline=true, no throw", async () => {
    const { clone, cleanup } = await setupOriginAndClone();
    try {
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      // Point origin at a bogus URL.
      await git.remote(["set-url", "origin", "/tmp/does-not-exist-xyz"]);
      const result = await syncFromRemote({ git });
      expect(result.offline).toBe(true);
      expect(result.conflict).toBe(false);
      expect(result.changedPaths).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("unexpected error rethrows instead of masquerading as offline", async () => {
    const { clone, cleanup } = await setupOriginAndClone();
    try {
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      const stub = {
        getRemotes: git.getRemotes.bind(git),
        raw: git.raw.bind(git),
        pull: async () => {
          throw new Error(
            "fatal: unable to read tree (abc123): corrupt object",
          );
        },
      } as unknown as typeof git;
      await expect(syncFromRemote({ git: stub })).rejects.toThrow(
        /corrupt object/,
      );
    } finally {
      await cleanup();
    }
  });
});
