import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";
import { alignWithRemote } from "../../../../../src/backend/vault/git/align.js";

interface OriginAndClone {
  origin: string;
  clone: string;
  cleanup: () => Promise<void>;
}

async function setupOriginWithCommit(): Promise<OriginAndClone> {
  const dir = await mkdtemp(join(tmpdir(), "align-test-"));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const clone = join(dir, "clone");
  await mkdir(origin);
  await initBareMain(origin);
  await simpleGit().env(scrubGitEnv()).clone(origin, seed);
  await configureIdentity(seed);
  await writeFile(join(seed, "first.md"), "shared\n");
  const seedGit = simpleGit({ baseDir: seed }).env(scrubGitEnv());
  await seedGit.add("first.md");
  await seedGit.commit("seed");
  await seedGit.push("origin", "HEAD:main");
  await simpleGit().env(scrubGitEnv()).clone(origin, clone);
  await configureIdentity(clone);
  return {
    origin,
    clone,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function configureIdentity(repo: string): Promise<void> {
  const git = simpleGit({ baseDir: repo }).env(scrubGitEnv());
  await git.addConfig("user.email", "t@x", false, "local");
  await git.addConfig("user.name", "t", false, "local");
}

// `init --bare` picks HEAD from init.defaultBranch, which is unset in CI —
// leaving HEAD symref'd to refs/heads/master. Clones then have no branch and
// pushes to `main` become non-fast-forward. Pin the bare HEAD to `main`.
async function initBareMain(origin: string): Promise<void> {
  await simpleGit().env(scrubGitEnv()).cwd(origin).init(true);
  await simpleGit()
    .env(scrubGitEnv())
    .cwd(origin)
    .raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
}

async function commit(
  git: SimpleGit,
  file: string,
  body: string,
  msg: string,
): Promise<void> {
  await writeFile(
    join((await git.revparse(["--show-toplevel"])).trim(), file),
    body,
  );
  await git.add(file);
  await git.commit(msg);
}

describe("alignWithRemote", () => {
  it("no-op when no origin remote configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "align-test-"));
    try {
      const git = simpleGit({ baseDir: dir }).env(scrubGitEnv());
      await git.init();
      await configureIdentity(dir);
      await commit(git, "x.md", "hi\n", "init");
      const before = (await git.log()).latest?.hash;
      await alignWithRemote(git);
      const after = (await git.log()).latest?.hash;
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no-op when origin unreachable", async () => {
    const { clone, cleanup } = await setupOriginWithCommit();
    try {
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      await git.remote(["set-url", "origin", "/tmp/does-not-exist-xyz-align"]);
      const before = (await git.log()).latest?.hash;
      await alignWithRemote(git);
      const after = (await git.log()).latest?.hash;
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it("no-op when origin/main missing (empty bare origin)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "align-test-"));
    try {
      const origin = join(dir, "origin.git");
      const clone = join(dir, "clone");
      await mkdir(origin);
      await initBareMain(origin);
      await mkdir(clone);
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      await git.init();
      await configureIdentity(clone);
      await git.addRemote("origin", origin);
      await commit(git, "local.md", "local-only\n", "local-init");
      const before = (await git.log()).latest?.hash;
      await alignWithRemote(git);
      const after = (await git.log()).latest?.hash;
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no-op when local is up-to-date with remote", async () => {
    const { clone, cleanup } = await setupOriginWithCommit();
    try {
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      const before = (await git.log()).latest?.hash;
      await alignWithRemote(git);
      const after = (await git.log()).latest?.hash;
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it("no-op when local is ahead of remote (local has unpushed commits)", async () => {
    const { clone, cleanup } = await setupOriginWithCommit();
    try {
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      await commit(git, "local.md", "ahead\n", "local commit");
      const before = (await git.log()).latest?.hash;
      await alignWithRemote(git);
      const after = (await git.log()).latest?.hash;
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it("fast-forwards when local is strictly behind remote", async () => {
    const { origin, clone, cleanup } = await setupOriginWithCommit();
    try {
      // Push a remote-only commit via a third clone.
      const other = clone + "-other";
      await simpleGit().env(scrubGitEnv()).clone(origin, other);
      await configureIdentity(other);
      const og = simpleGit({ baseDir: other }).env(scrubGitEnv());
      await commit(og, "added.md", "remote-new\n", "remote-add");
      await og.push("origin", "HEAD:main");

      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      const localBefore = (await git.log()).latest?.hash;
      await alignWithRemote(git);
      const localAfter = (await git.log()).latest?.hash;
      const remoteHead = (await git.raw(["rev-parse", "origin/main"])).trim();
      expect(localAfter).toBe(remoteHead);
      expect(localAfter).not.toBe(localBefore);
      // Upstream tracking now set.
      const upstream = (
        await git.raw(["rev-parse", "--abbrev-ref", "main@{u}"])
      ).trim();
      expect(upstream).toBe("origin/main");
    } finally {
      await cleanup();
    }
  });

  it("hard-resets to remote when histories are unrelated (no common ancestor)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "align-test-"));
    try {
      const origin = join(dir, "origin.git");
      const seed = join(dir, "seed");
      const fresh = join(dir, "fresh");
      await mkdir(origin);
      await initBareMain(origin);

      // Populate origin via seed clone.
      await simpleGit().env(scrubGitEnv()).clone(origin, seed);
      await configureIdentity(seed);
      const seedGit = simpleGit({ baseDir: seed }).env(scrubGitEnv());
      await commit(seedGit, "remote-only.md", "remote\n", "remote-root");
      await seedGit.push("origin", "HEAD:main");
      const remoteHeadSha = (await seedGit.revparse(["HEAD"])).trim();

      // Fresh repo with its OWN initial commit and origin pointing at the
      // pre-populated bare — simulates a second-vault bootstrap where
      // ensureVaultGit ran locally before the first fetch.
      await mkdir(fresh);
      const freshGit = simpleGit({ baseDir: fresh }).env(scrubGitEnv());
      await freshGit.init();
      await configureIdentity(fresh);
      await freshGit.addRemote("origin", origin);
      await commit(freshGit, "local-bootstrap.md", "local\n", "local-root");
      await freshGit.raw(["branch", "-m", "main"]).catch(() => undefined);

      await alignWithRemote(freshGit);

      const after = (await freshGit.revparse(["HEAD"])).trim();
      expect(after).toBe(remoteHeadSha);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when histories diverge with shared ancestor (refuses destructive reset)", async () => {
    const { origin, clone, cleanup } = await setupOriginWithCommit();
    try {
      // Local-only commit on top of shared ancestor.
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      await commit(git, "local.md", "local-only\n", "local divergence");
      const localBefore = (await git.log()).latest?.hash;

      // Remote-only commit pushed via another clone.
      const other = clone + "-other";
      await simpleGit().env(scrubGitEnv()).clone(origin, other);
      await configureIdentity(other);
      const og = simpleGit({ baseDir: other }).env(scrubGitEnv());
      await commit(og, "remote.md", "remote-only\n", "remote divergence");
      await og.push("origin", "HEAD:main");

      await expect(alignWithRemote(git)).rejects.toThrow(
        /diverged.*shared ancestor/i,
      );
      // Local HEAD untouched.
      const localAfter = (await git.log()).latest?.hash;
      expect(localAfter).toBe(localBefore);
    } finally {
      await cleanup();
    }
  });
});
