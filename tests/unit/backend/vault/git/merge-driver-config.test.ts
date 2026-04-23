import { describe, it, expect } from "vitest";
import { simpleGit } from "simple-git";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMergeDriverConfig } from "../../../../../src/backend/vault/git/merge-driver-config.js";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";

describe("ensureMergeDriverConfig", () => {
  it("writes driver name + path to .git/config", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdc-"));
    const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
    await git.init();
    await ensureMergeDriverConfig({ root, driverPath: "/abs/merge-memory.js" });
    const name = await git.raw([
      "config",
      "--local",
      "merge.agent-brain-memory.name",
    ]);
    const driver = await git.raw([
      "config",
      "--local",
      "merge.agent-brain-memory.driver",
    ]);
    expect(name.trim()).toBe("agent-brain memory-file merge");
    expect(driver.trim()).toBe('node "/abs/merge-memory.js" %A %O %B');
  });

  it("rewrites driver path on each call (self-heals)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdc-"));
    const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
    await git.init();
    await ensureMergeDriverConfig({ root, driverPath: "/abs/old.js" });
    await ensureMergeDriverConfig({ root, driverPath: "/abs/new.js" });
    const driver = await git.raw([
      "config",
      "--local",
      "merge.agent-brain-memory.driver",
    ]);
    expect(driver.trim()).toBe('node "/abs/new.js" %A %O %B');
  });
});
