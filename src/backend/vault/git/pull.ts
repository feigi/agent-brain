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

const CONFLICT_RE = /CONFLICT|could not apply|Merge conflict|rebase.*conflict/i;

// Patterns that classify as `offline: true` — we keep serving local data.
// Anything not matched here (corrupt refs, disk-full, gpg failures,
// unrelated histories, programmer errors) is rethrown so operators notice.
const OFFLINE_RE =
  /Could not resolve host|Could not read from remote repository|Connection (?:refused|timed out|reset)|Operation timed out|Network is unreachable|authentication failed|Permission denied \(publickey|unable to access|no tracking information|couldn't find remote ref|repository .* not found|does not appear to be a git repository/i;

/**
 * Runs `git pull --rebase --autostash`. Classifies failures rather than
 * throwing on the expected network/auth path. Rebase conflicts abort via
 * `git rebase --abort` so the working tree returns to the pre-pull HEAD.
 * Known network / auth / missing-upstream errors surface as
 * `offline: true`. All other errors are rethrown — treating them as offline
 * masks real failures (corrupt refs, disk-full, gpg, unrelated histories).
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
    if (CONFLICT_RE.test(msg)) {
      try {
        await cfg.git.raw(["rebase", "--abort"]);
      } catch (abortErr) {
        logger.error(
          `vault: rebase --abort failed after conflict: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
        );
      }
      return { offline: false, conflict: true, changedPaths: [] };
    }
    if (OFFLINE_RE.test(msg)) {
      logger.warn(`vault: pull failed, serving local: ${msg}`);
      return { offline: true, conflict: false, changedPaths: [] };
    }
    logger.error(`vault: pull failed with unexpected error: ${msg}`);
    throw err;
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
