import { describe, expect, it } from "vitest";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import {
  makeMemory,
  setupBareAndTwoVaults,
} from "../../contract/repositories/_git-helpers.js";
import { VaultBackend } from "../../../src/backend/vault/index.js";
import { scrubGitEnv } from "../../../src/backend/vault/git/env.js";

/**
 * Polls until `@{u}` resolves AND `@{u}..HEAD` is empty, meaning at
 * least one push has landed and there are no further unpushed commits.
 * Unlike the indirect sessionStart meta signal, this directly checks
 * what we care about: upstream tracking is configured AND all commits
 * are pushed.
 */
async function waitForPushSettled(root: string): Promise<void> {
  const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
  for (let i = 0; i < 100; i++) {
    try {
      await git.raw(["rev-parse", "@{u}"]);
      const out = await git.raw(["rev-list", "--count", "@{u}..HEAD"]);
      if (Number(out.trim()) === 0) return;
    } catch {
      // @{u} not yet set — first push hasn't landed yet. Keep polling.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    "timed out waiting for push to settle (@{u} set + 0 unpushed)",
  );
}

const DIMS = 768;

function fakeEmbed(): (text: string) => Promise<number[]> {
  return async () => new Array(DIMS).fill(0.01);
}

async function createBackend(
  root: string,
  remoteUrl: string,
): Promise<VaultBackend> {
  return VaultBackend.create({
    root,
    embeddingDimensions: DIMS,
    remoteUrl,
    pushDebounceMs: 10,
    pushBackoffMs: [50, 200],
    embed: fakeEmbed(),
  });
}

describe("vault two-clone sync", () => {
  it("write on A is visible on B after A pushes and B session-starts", async () => {
    const { bare, vaultA, vaultB, cleanup } = await setupBareAndTwoVaults();
    try {
      const a = await createBackend(vaultA, bare);
      // Seed first commit so bare repo has `main` branch.
      await a.memoryRepo.create(makeMemory("m1"));
      await waitForPushSettled(vaultA);

      const b = await createBackend(vaultB, bare);
      const meta = await b.sessionStart();
      expect(meta.pull_conflict).toBeUndefined();
      expect(meta.offline).toBeUndefined();

      const found = await b.memoryRepo.findById("m1");
      expect(found?.title).toBe("t-m1");

      await a.close();
      await b.close();
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("non-conflicting concurrent writes merge cleanly", async () => {
    const { bare, vaultA, vaultB, cleanup } = await setupBareAndTwoVaults();
    try {
      const a = await createBackend(vaultA, bare);
      await a.memoryRepo.create(makeMemory("seed"));
      await waitForPushSettled(vaultA);

      const b = await createBackend(vaultB, bare);
      await b.sessionStart();

      await a.memoryRepo.create(makeMemory("from-a"));
      await b.memoryRepo.create(makeMemory("from-b"));
      await waitForPushSettled(vaultA);

      const bMeta = await b.sessionStart();
      expect(bMeta.pull_conflict).toBeUndefined();
      await waitForPushSettled(vaultB);

      const aMeta = await a.sessionStart();
      expect(aMeta.pull_conflict).toBeUndefined();

      expect(await a.memoryRepo.findById("from-b")).not.toBeNull();
      expect(await b.memoryRepo.findById("from-a")).not.toBeNull();

      await a.close();
      await b.close();
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("conflicting writes on same file surface pull_conflict", async () => {
    const { bare, vaultA, vaultB, cleanup } = await setupBareAndTwoVaults();
    try {
      const a = await createBackend(vaultA, bare);
      // Create a memory that will be the conflict target.
      await a.memoryRepo.create(makeMemory("target"));
      await waitForPushSettled(vaultA);

      const b = await createBackend(vaultB, bare);
      await b.sessionStart(); // pull A's target into B

      // Strategy: produce a modify/delete conflict, which git rebase
      // cannot resolve even with `*.md merge=union`. A deletes the
      // file via direct git manipulation; B updates it via the vault
      // API. When B pulls (rebases), git sees "deleted in HEAD,
      // modified in B's commit" → CONFLICT.
      const gitA = simpleGit({ baseDir: vaultA }).env(scrubGitEnv());
      const targetPath = join("workspaces", "ws1", "memories", "target.md");
      await unlink(join(vaultA, targetPath));
      await gitA.rm([targetPath]);
      await gitA.commit("[test] delete target to force conflict", [targetPath]);
      // Push A's deletion so origin has "target deleted".
      await gitA.raw(["push", "--set-upstream", "origin", "HEAD:main"]);

      // B updates the same file through the vault API.
      const targetOnB = await b.memoryRepo.findById("target");
      if (!targetOnB) throw new Error("target not found on B");
      await b.memoryRepo.update("target", targetOnB.version, {
        title: "b-updated-title",
      });

      // B's sessionStart pulls → rebase applies B's modify-commit on
      // top of A's delete-commit → modify/delete conflict → pull_conflict.
      const bMeta = await b.sessionStart();
      expect(bMeta.pull_conflict).toBe(true);

      await a.close();
      await b.close();
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("diverged clone with shared ancestor refuses destructive reset at bootstrap", async () => {
    const { bare, vaultA, vaultB, cleanup } = await setupBareAndTwoVaults();
    try {
      // A seeds the remote.
      const a = await createBackend(vaultA, bare);
      await a.memoryRepo.create(makeMemory("from-a"));
      await waitForPushSettled(vaultA);
      await a.close();

      // Clone origin into vaultB so both share the bootstrap history,
      // then diverge: add a local-only commit on B AND a new commit on A
      // that doesn't exist in B.
      await simpleGit().env(scrubGitEnv()).clone(bare, vaultB);
      const gitB = simpleGit({ baseDir: vaultB }).env(scrubGitEnv());
      await gitB.addConfig("user.email", "b@x", false, "local");
      await gitB.addConfig("user.name", "b", false, "local");

      // B commits an unpushed local memory.
      const bLocalOnly = await VaultBackend.create({
        root: vaultB,
        embeddingDimensions: DIMS,
        pushDebounceMs: 10,
        pushBackoffMs: [50, 200],
        embed: fakeEmbed(),
      });
      await bLocalOnly.memoryRepo.create(makeMemory("from-b-local"));
      await bLocalOnly.close();

      // A (a third clone) pushes a new commit so origin moves forward
      // without B's commit.
      const vaultC = vaultA + "-c";
      await simpleGit().env(scrubGitEnv()).clone(bare, vaultC);
      const c = await createBackend(vaultC, bare);
      await c.memoryRepo.create(makeMemory("from-a-2"));
      await waitForPushSettled(vaultC);
      await c.close();

      const headBefore = (await gitB.revparse(["HEAD"])).trim();

      // B now diverges from origin (ahead=1, behind=1) with shared
      // ancestor — align must throw rather than reset --hard.
      await expect(createBackend(vaultB, bare)).rejects.toThrow(
        /shared ancestor/i,
      );

      const headAfter = (await gitB.revparse(["HEAD"])).trim();
      expect(headAfter).toBe(headBefore);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("offline mode: origin unreachable → meta.offline=true, writes still commit", async () => {
    const { bare, vaultA, cleanup } = await setupBareAndTwoVaults();
    try {
      const a = await createBackend(vaultA, bare);
      await a.memoryRepo.create(makeMemory("seed"));
      await waitForPushSettled(vaultA);
      // Break origin. Retry a few times on ENOTEMPTY — macOS can hold
      // file descriptors on bare-repo pack files briefly after git ops.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rm(bare, { recursive: true, force: true });
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOTEMPTY" && attempt < 4) {
            await new Promise((r) => setTimeout(r, 50));
          } else {
            throw err;
          }
        }
      }

      await a.memoryRepo.create(makeMemory("offline-write"));
      const meta = await a.sessionStart();
      expect(meta.offline).toBe(true);
      expect(meta.unpushed_commits ?? 0).toBeGreaterThan(0);

      await a.close();
    } finally {
      await cleanup();
    }
  }, 30_000);
});
