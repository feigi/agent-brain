import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";

export interface SyncFromRemoteConfig {
  git: SimpleGit;
}

export interface SyncResult {
  offline: boolean;
  conflict: boolean;
  /** Paths changed by the pull (git-relative, forward-slash). */
  changedPaths: string[];
}

/**
 * Runs `git pull --rebase --autostash`. Classifies failures rather than
 * throwing. Rebase conflicts abort via `git rebase --abort` so the working
 * tree returns to the pre-pull HEAD. Network / auth failures surface as
 * `offline: true`. Caller decides whether to serve local stale data.
 */
export async function syncFromRemote(
  cfg: SyncFromRemoteConfig,
): Promise<SyncResult> {
  // Short-circuit when no origin is configured — pull would throw
  // "no tracking information".
  const remotes = await cfg.git.getRemotes(true);
  if (!remotes.some((r) => r.name === "origin")) {
    return { offline: false, conflict: false, changedPaths: [] };
  }

  const preHead = await resolveHead(cfg.git);

  try {
    await cfg.git.pull("origin", "main", {
      "--rebase": null,
      "--autostash": null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/CONFLICT|could not apply|Merge conflict|rebase.*conflict/i.test(msg)) {
      try {
        await cfg.git.raw(["rebase", "--abort"]);
      } catch (abortErr) {
        logger.error(
          `vault: rebase --abort failed after conflict: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
        );
      }
      return { offline: false, conflict: true, changedPaths: [] };
    }
    // Treat everything else as offline/transient — network, auth, no
    // upstream, host unreachable, etc.
    logger.warn(`vault: pull failed, serving local: ${msg}`);
    return { offline: true, conflict: false, changedPaths: [] };
  }

  const postHead = await resolveHead(cfg.git);
  if (!preHead || !postHead || preHead === postHead) {
    return { offline: false, conflict: false, changedPaths: [] };
  }
  const diff = await cfg.git.raw([
    "diff",
    "--name-only",
    `${preHead}..${postHead}`,
  ]);
  const changedPaths = diff
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { offline: false, conflict: false, changedPaths };
}

async function resolveHead(git: SimpleGit): Promise<string | null> {
  try {
    const sha = await git.raw(["rev-parse", "HEAD"]);
    return sha.trim();
  } catch {
    return null;
  }
}
