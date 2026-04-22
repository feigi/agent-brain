import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { GitOpsImpl } from "../../../../../src/backend/vault/git/git-ops.js";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";

describe("GitOpsImpl", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gitops-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("isRepo returns false for a non-git directory", async () => {
    const ops = new GitOpsImpl({ root });
    expect(await ops.isRepo()).toBe(false);
  });

  it("init turns a directory into a git repo", async () => {
    const ops = new GitOpsImpl({ root });
    await ops.init();
    expect(await ops.isRepo()).toBe(true);
  });

  it("init is idempotent", async () => {
    const ops = new GitOpsImpl({ root });
    await ops.init();
    await ops.init();
    expect(await ops.isRepo()).toBe(true);
  });

  it("stageAndCommit stages listed paths and commits with trailers", async () => {
    const ops = new GitOpsImpl({ root });
    await ops.init();
    await configUser(root);
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub/a.md"), "# a", "utf8");
    await ops.stageAndCommit(["sub/a.md"], "[agent-brain] created: A", {
      action: "created",
      memoryId: "abc",
      actor: "alice",
    });
    const git = simpleGit(root).env(scrubGitEnv());
    const log = await git.log();
    expect(log.latest?.message).toMatch(/^\[agent-brain\] created: A/);
    expect(log.latest?.body).toContain("AB-Action: created");
    expect(log.latest?.body).toContain("AB-Memory: abc");
    expect(log.latest?.body).toContain("AB-Actor: alice");
  });

  it("stageAndCommit throws a typed error when the working tree has no changes", async () => {
    const ops = new GitOpsImpl({ root });
    await ops.init();
    await configUser(root);
    await writeFile(join(root, "a.md"), "x", "utf8");
    await ops.stageAndCommit(["a.md"], "s", {
      action: "created",
      memoryId: "abc",
      actor: "alice",
    });
    await expect(
      ops.stageAndCommit(["a.md"], "s2", {
        action: "updated",
        memoryId: "abc",
        actor: "alice",
      }),
    ).rejects.toThrow(/nothing to commit/i);
  });

  it("status returns clean=true on an empty repo with no staged changes", async () => {
    const ops = new GitOpsImpl({ root });
    await ops.init();
    expect((await ops.status()).clean).toBe(true);
  });
});

async function configUser(root: string): Promise<void> {
  const git = simpleGit(root).env(scrubGitEnv());
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
}
