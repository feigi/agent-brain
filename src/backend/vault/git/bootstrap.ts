import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { DomainError } from "../../../utils/errors.js";
import { mergeGitignore } from "./gitignore-merge.js";
import { scrubGitEnv } from "./env.js";

export interface EnsureVaultGitOptions {
  root: string;
  trackUsers: boolean;
}

const RUNTIME_IGNORES = [
  ".agent-brain/",
  "_sessions/",
  "_session-tracking/",
  "_scheduler-state.json",
  "_audit/",
];

const GITATTRIBUTES_RULE = "*.md merge=union";

export async function ensureVaultGit(
  opts: EnsureVaultGitOptions,
): Promise<void> {
  const git = simpleGit({ baseDir: opts.root }).env(scrubGitEnv());
  const wasRepo = await git.checkIsRepo();
  if (!wasRepo) {
    await git.init();
  }
  // Commits need a user.email/user.name pair. On docker, CI, or a
  // fresh dev machine neither may be set globally, which would make
  // every stageAndCommit fail silently. Set repo-local fallbacks but
  // never override an operator-configured identity.
  await ensureIdentity(git);
  const ignoreChanged = await ensureGitignore(opts.root, opts.trackUsers);
  const attrChanged = await ensureGitattributes(opts.root);
  await assertRequiredRules(opts.root, opts.trackUsers);
  // Commit bootstrap files so a clone of the vault carries the
  // privacy-critical `users/` rule. Without this, the files stay
  // untracked and a clone has no .gitignore at all.
  if (!wasRepo || ignoreChanged || attrChanged) {
    await commitBootstrap(git);
  }
}

async function ensureIdentity(git: SimpleGit): Promise<void> {
  await ensureConfig(git, "user.email", "agent-brain@localhost");
  await ensureConfig(git, "user.name", "agent-brain");
}

async function ensureConfig(
  git: SimpleGit,
  key: string,
  fallback: string,
): Promise<void> {
  try {
    const { value } = await git.getConfig(key);
    if (value) return;
  } catch {
    // `git config --get <key>` exits 1 when unset — treat as unset.
  }
  await git.addConfig(key, fallback);
}

async function ensureGitignore(
  root: string,
  trackUsers: boolean,
): Promise<boolean> {
  const path = join(root, ".gitignore");
  const required = trackUsers
    ? RUNTIME_IGNORES
    : [...RUNTIME_IGNORES, "users/"];
  const existing = await readOrEmpty(path);
  const merged = mergeGitignore(existing, required);
  if (merged === existing) return false;
  await writeFile(path, merged, "utf8");
  return true;
}

async function ensureGitattributes(root: string): Promise<boolean> {
  const path = join(root, ".gitattributes");
  const existing = await readOrEmpty(path);
  if (hasActiveRule(existing, GITATTRIBUTES_RULE)) return false;
  const trailingNewline =
    existing === "" || existing.endsWith("\n") ? "" : "\n";
  const merged = existing + trailingNewline + `${GITATTRIBUTES_RULE}\n`;
  await writeFile(path, merged, "utf8");
  return true;
}

// Line-based check so the rule inside a comment like
// `# don't use *.md merge=union` doesn't count as present.
function hasActiveRule(body: string, rule: string): boolean {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed === rule) return true;
  }
  return false;
}

// Re-read after write to confirm every required rule actually landed
// in the bytes on disk. A bug in mergeGitignore or a racing writer
// could leave the privacy rule absent; fail loudly rather than leak.
async function assertRequiredRules(
  root: string,
  trackUsers: boolean,
): Promise<void> {
  const ignoreBody = await readOrEmpty(join(root, ".gitignore"));
  const ignoreLines = new Set(ignoreBody.split(/\r?\n/).map((l) => l.trim()));
  const required = trackUsers
    ? RUNTIME_IGNORES
    : [...RUNTIME_IGNORES, "users/"];
  for (const rule of required) {
    if (!ignoreLines.has(rule)) {
      throw new DomainError(
        `vault bootstrap failed: .gitignore is missing rule '${rule}'`,
        "VAULT_BOOTSTRAP_FAILED",
        500,
      );
    }
  }
  const attrBody = await readOrEmpty(join(root, ".gitattributes"));
  if (!hasActiveRule(attrBody, GITATTRIBUTES_RULE)) {
    throw new DomainError(
      `vault bootstrap failed: .gitattributes is missing rule '${GITATTRIBUTES_RULE}'`,
      "VAULT_BOOTSTRAP_FAILED",
      500,
    );
  }
}

async function commitBootstrap(git: SimpleGit): Promise<void> {
  await git.add([".gitignore", ".gitattributes"]);
  const status = await git.status();
  if (status.staged.length === 0 && status.created.length === 0) return;
  await git.commit(
    "[agent-brain] bootstrap: initialize vault structure\n\nAB-Action: bootstrap\nAB-Actor: system",
    [".gitignore", ".gitattributes"],
  );
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return "";
    throw err;
  }
}
