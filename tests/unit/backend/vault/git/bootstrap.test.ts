import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { ensureVaultGit } from "../../../../../src/backend/vault/git/bootstrap.js";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";

describe("ensureVaultGit", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bootstrap-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a git repo, .gitignore, and .gitattributes on a fresh dir", async () => {
    await ensureVaultGit({ root, trackUsers: false });
    const git = simpleGit(root).env(scrubGitEnv());
    expect(await git.checkIsRepo()).toBe(true);
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain(".agent-brain/");
    expect(ignore).toContain("users/");
    const attrs = await readFile(join(root, ".gitattributes"), "utf8");
    expect(attrs).toContain("merge=agent-brain-memory");
    expect(attrs).not.toContain("*.md merge=union");
  });

  it("omits users/ from .gitignore when trackUsers=true", async () => {
    await ensureVaultGit({ root, trackUsers: true });
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).not.toMatch(/^users\/$/m);
  });

  it("merges into an existing .gitignore without duplicating rules", async () => {
    await writeFile(join(root, ".gitignore"), "node_modules\nusers/\n", "utf8");
    await ensureVaultGit({ root, trackUsers: false });
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("node_modules");
    const usersCount = ignore
      .split("\n")
      .filter((l) => l.trim() === "users/").length;
    expect(usersCount).toBe(1);
  });

  it("appends path-specific merge=agent-brain-memory rules to an existing .gitattributes, preserving prior rules", async () => {
    await writeFile(join(root, ".gitattributes"), "*.json binary\n", "utf8");
    await ensureVaultGit({ root, trackUsers: false });
    const attrs = await readFile(join(root, ".gitattributes"), "utf8");
    expect(attrs).toContain("*.json binary");
    expect(attrs).toContain("merge=agent-brain-memory");
    expect(attrs).not.toContain("*.md merge=union");
  });

  it("appends path-specific rules even when a comment mentions an old rule", async () => {
    await writeFile(
      join(root, ".gitattributes"),
      "# reminder: *.md merge=union\n",
      "utf8",
    );
    await ensureVaultGit({ root, trackUsers: false });
    // hasActiveRule is line-based, so the comment should not count as
    // present — bootstrap must append the real rules.
    const attrs = await readFile(join(root, ".gitattributes"), "utf8");
    const active = attrs
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(active).toContain(
      "workspaces/**/memories/*.md merge=agent-brain-memory",
    );
    expect(active).toContain("project/memories/*.md merge=agent-brain-memory");
    expect(active).toContain("users/**/memories/*.md merge=agent-brain-memory");
    expect(active).not.toContain("*.md merge=union");
  });

  it("is idempotent: second call produces byte-identical files", async () => {
    await ensureVaultGit({ root, trackUsers: false });
    const ignoreA = await readFile(join(root, ".gitignore"), "utf8");
    const attrsA = await readFile(join(root, ".gitattributes"), "utf8");
    await ensureVaultGit({ root, trackUsers: false });
    const ignoreB = await readFile(join(root, ".gitignore"), "utf8");
    const attrsB = await readFile(join(root, ".gitattributes"), "utf8");
    expect(ignoreB).toBe(ignoreA);
    expect(attrsB).toBe(attrsA);
  });

  it("preserves pre-existing commits and adds a bootstrap commit for new files", async () => {
    const git = simpleGit(root).env(scrubGitEnv());
    await git.init();
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    await writeFile(join(root, "pre.md"), "x", "utf8");
    await git.add("pre.md");
    await git.commit("pre");
    const preHash = (await git.log()).latest?.hash;
    await ensureVaultGit({ root, trackUsers: false });
    const log = await git.log();
    // Pre-existing commit still on the history.
    expect(log.all.some((c) => c.hash === preHash)).toBe(true);
    // New HEAD is the bootstrap commit for .gitignore/.gitattributes.
    expect(log.latest?.message).toContain(
      "bootstrap: initialize vault structure",
    );
  });

  it("does not re-commit when .gitignore and .gitattributes already match", async () => {
    await ensureVaultGit({ root, trackUsers: false });
    const git = simpleGit(root).env(scrubGitEnv());
    const headBefore = (await git.log()).latest?.hash;
    await ensureVaultGit({ root, trackUsers: false });
    const headAfter = (await git.log()).latest?.hash;
    expect(headAfter).toBe(headBefore);
  });

  it("writes the merge driver config on bootstrap", async () => {
    const root = await mkdtemp(join(tmpdir(), "vault-"));
    await ensureVaultGit({ root, trackUsers: false });
    const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
    const driver = await git.raw([
      "config",
      "--local",
      "merge.agent-brain-memory.driver",
    ]);
    expect(driver).toMatch(/node ".+merge-memory\.js" %A %O %B/);
  });

  it("writes the three memory-path merge=agent-brain-memory rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vault-"));
    await ensureVaultGit({ root, trackUsers: true });
    const body = await readFile(join(root, ".gitattributes"), "utf8");
    expect(body).toMatch(
      /^workspaces\/\*\*\/memories\/\*\.md merge=agent-brain-memory$/m,
    );
    expect(body).toMatch(
      /^project\/memories\/\*\.md merge=agent-brain-memory$/m,
    );
    expect(body).toMatch(
      /^users\/\*\*\/memories\/\*\.md merge=agent-brain-memory$/m,
    );
    expect(body).not.toMatch(/^\*\.md merge=union$/m);
  });

  it("migrates a Phase 4b vault by replacing *.md merge=union", async () => {
    const root = await mkdtemp(join(tmpdir(), "vault-"));
    // Simulate a Phase 4b bootstrap
    await writeFile(join(root, ".gitattributes"), "*.md merge=union\n", "utf8");
    const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
    await git.init();
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    await git.add([".gitattributes"]);
    await git.commit("seed");

    await ensureVaultGit({ root, trackUsers: false });
    const body = await readFile(join(root, ".gitattributes"), "utf8");
    expect(body).not.toMatch(/merge=union/);
    expect(body).toMatch(/merge=agent-brain-memory/);
  });
});

describe("ensureVaultGit — _audit/ cleanup", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes an existing _audit/ directory on startup", async () => {
    await mkdir(join(root, "_audit"), { recursive: true });
    await writeFile(join(root, "_audit", "mem-1.jsonl"), "{}\n", "utf8");
    await ensureVaultGit({ root, trackUsers: false });
    await expect(stat(join(root, "_audit"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not list _audit/ in the committed .gitignore", async () => {
    await ensureVaultGit({ root, trackUsers: false });
    const body = await readFile(join(root, ".gitignore"), "utf8");
    expect(body).not.toMatch(/^_audit\/?$/m);
  });
});
