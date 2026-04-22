import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";
import { ensureRemote } from "../../../../../src/backend/vault/git/remote.js";
import { logger } from "../../../../../src/utils/logger.js";

async function makeRepo(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "remote-test-"));
  const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
  await git.init();
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("ensureRemote", () => {
  it("adds origin when absent + URL provided", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      await ensureRemote({ git, remoteUrl: "git@example.com:x/y.git" });
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin");
      expect(origin?.refs.fetch).toBe("git@example.com:x/y.git");
    } finally {
      await cleanup();
    }
  });

  it("no-ops when origin already matches", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      await git.addRemote("origin", "git@example.com:x/y.git");
      await ensureRemote({ git, remoteUrl: "git@example.com:x/y.git" });
      const remotes = await git.getRemotes(true);
      expect(remotes).toHaveLength(1);
      expect(remotes[0].refs.fetch).toBe("git@example.com:x/y.git");
    } finally {
      await cleanup();
    }
  });

  it("leaves mismatched origin in place + warns", async () => {
    const { root, cleanup } = await makeRepo();
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      await git.addRemote("origin", "git@existing:a/b.git");
      await ensureRemote({ git, remoteUrl: "git@new:c/d.git" });
      const remotes = await git.getRemotes(true);
      expect(remotes[0].refs.fetch).toBe("git@existing:a/b.git");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/configured remoteUrl/),
      );
    } finally {
      warnSpy.mockRestore();
      await cleanup();
    }
  });

  it("no-ops when no URL and no origin", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      await ensureRemote({ git, remoteUrl: undefined });
      const remotes = await git.getRemotes(true);
      expect(remotes).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
