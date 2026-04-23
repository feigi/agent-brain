import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";
import { scrubGitEnv } from "./env.js";

export interface EnsureMergeDriverConfigOptions {
  /** Absolute path to the vault root (the directory containing `.git/`). */
  root: string;
  driverPath: string; // absolute path to the compiled merge-memory CLI
}

export async function ensureMergeDriverConfig(
  opts: EnsureMergeDriverConfigOptions,
): Promise<void> {
  // simple-git's security plugin blocks `merge.*.driver` writes unless
  // `unsafe.allowUnsafeMergeDriver` is explicitly opted in.  This is a
  // legitimate use-case (we are the ones installing the driver), so we
  // create a private git instance with that flag set rather than
  // requiring all callers to do so.
  const git = simpleGit({
    baseDir: opts.root,
    unsafe: { allowUnsafeMergeDriver: true },
  }).env(scrubGitEnv());

  // Quote the driver path so spaces in the install location don't
  // break the merge subprocess. %A %O %B are substituted by git.
  const command = `node "${opts.driverPath}" %A %O %B`;
  // `config --local --replace-all` is the idempotent form; plain
  // `--add` would append duplicates across bootstraps.
  await git.raw([
    "config",
    "--local",
    "--replace-all",
    "merge.agent-brain-memory.name",
    "agent-brain memory-file merge",
  ]);
  await git.raw([
    "config",
    "--local",
    "--replace-all",
    "merge.agent-brain-memory.driver",
    command,
  ]);
}

/**
 * Resolves the absolute path to the compiled merge driver. Prefers the
 * installed package entry; falls back to the repo-local dist/ for
 * development clones.
 */
export function resolveDriverPath(): string {
  try {
    // `agent-brain` bin path: dist/src/cli/merge-memory.js (per Task 5 emit layout).
    const require = createRequire(import.meta.url);
    return require.resolve("agent-brain/dist/src/cli/merge-memory.js");
  } catch {
    // Dev fallback: resolve relative to this compiled module's location.
    // At runtime this file lives at `<...>/dist/src/backend/vault/git/merge-driver-config.js`.
    // The CLI lives at `<...>/dist/src/cli/merge-memory.js`, so ../../../cli/merge-memory.js.
    return fileURLToPath(
      new URL("../../../cli/merge-memory.js", import.meta.url),
    );
  }
}
