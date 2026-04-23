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
 *
 * The dev fallback handles two execution contexts:
 *  - Compiled JS (dist/):  this file is at dist/src/backend/vault/git/…
 *    → ../../../cli/merge-memory.js resolves to dist/src/cli/merge-memory.js ✓
 *  - TypeScript source (src/, via tsx / vitest):  import.meta.url ends in
 *    .ts and this file is at src/backend/vault/git/… so the same relative
 *    path would land in src/cli/merge-memory.js (a .ts file, not a Node
 *    subprocess).  Detect the .ts suffix and add one extra dist/ segment.
 */
export function resolveDriverPath(): string {
  try {
    // `agent-brain` bin path: dist/src/cli/merge-memory.js (per Task 5 emit layout).
    const require = createRequire(import.meta.url);
    return require.resolve("agent-brain/dist/src/cli/merge-memory.js");
  } catch {
    // Dev fallback.
    const thisUrl = import.meta.url;
    if (thisUrl.endsWith(".ts")) {
      // Running under tsx/vitest from TypeScript sources.
      // This file: <project>/src/backend/vault/git/merge-driver-config.ts
      // CLI target: <project>/dist/src/cli/merge-memory.js
      // Go up 4 levels (git/ → vault/ → backend/ → src/) then into dist/src/cli/.
      return fileURLToPath(
        new URL("../../../../dist/src/cli/merge-memory.js", thisUrl),
      );
    }
    // Compiled JS: this file lives at dist/src/backend/vault/git/…
    // CLI lives at dist/src/cli/merge-memory.js → go up 3 levels.
    return fileURLToPath(new URL("../../../cli/merge-memory.js", thisUrl));
  }
}
