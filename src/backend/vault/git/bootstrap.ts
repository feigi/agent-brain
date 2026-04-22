import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
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

const GITATTRIBUTES = "*.md merge=union\n";

export async function ensureVaultGit(
  opts: EnsureVaultGitOptions,
): Promise<void> {
  const git = simpleGit({ baseDir: opts.root }).env(scrubGitEnv());
  if (!(await git.checkIsRepo())) {
    await git.init();
  }
  await ensureGitignore(opts.root, opts.trackUsers);
  await ensureGitattributes(opts.root);
}

async function ensureGitignore(
  root: string,
  trackUsers: boolean,
): Promise<void> {
  const path = join(root, ".gitignore");
  const required = trackUsers
    ? RUNTIME_IGNORES
    : [...RUNTIME_IGNORES, "users/"];
  const existing = await readOrEmpty(path);
  const merged = mergeGitignore(existing, required);
  if (merged !== existing) {
    await writeFile(path, merged, "utf8");
  }
}

async function ensureGitattributes(root: string): Promise<void> {
  const path = join(root, ".gitattributes");
  const existing = await readOrEmpty(path);
  if (existing.includes("*.md merge=union")) return;
  const merged =
    existing === ""
      ? GITATTRIBUTES
      : existing + (existing.endsWith("\n") ? "" : "\n") + GITATTRIBUTES;
  await writeFile(path, merged, "utf8");
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return "";
    throw err;
  }
}
