import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";

export interface SyncFromRemoteConfig {
  git: SimpleGit;
}

// Discriminated union: callers switch on `kind` rather than checking
// independent booleans whose combinations are logically impossible.
export type SyncResult =
  | { kind: "offline" }
  | { kind: "conflict"; rebaseWedged?: true }
  | { kind: "ok"; changedPaths: string[] };

const CONFLICT_RE = /CONFLICT|could not apply|Merge conflict|rebase.*conflict/i;

// Patterns that classify as `offline: true` — we keep serving local data.
// Auth failures bucket with offline (both mean "can't reach remote; keep
// serving local"); distinguishing them would complicate client UX without
// an actionable difference.
// Anything not matched here (corrupt refs, disk-full, gpg failures,
// unrelated histories, programmer errors) is rethrown so operators notice.
export const OFFLINE_RE =
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
    return { kind: "ok", changedPaths: [] };
  }

  const preHead = await resolveHead(cfg.git);

  try {
    // --autostash handles a dirty tree from a crashed write between
    // markdown-emit and commit; without it the rebase aborts.
    await cfg.git.pull("origin", "main", {
      "--rebase": null,
      "--autostash": null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (CONFLICT_RE.test(msg)) {
      let wedged = false;
      try {
        await cfg.git.raw(["rebase", "--abort"]);
      } catch (abortErr) {
        wedged = true;
        logger.error(
          `vault: rebase --abort failed after conflict: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
        );
      }
      // Drop any autostash entry restored by abort — we don't want it
      // accumulating on subsequent pulls, and we never pop it back.
      await cfg.git.raw(["stash", "drop"]).catch(() => undefined);
      return wedged
        ? { kind: "conflict", rebaseWedged: true }
        : { kind: "conflict" };
    }
    if (OFFLINE_RE.test(msg)) {
      logger.warn(`vault: pull failed, serving local: ${msg}`);
      return { kind: "offline" };
    }
    logger.error(`vault: pull failed with unexpected error: ${msg}`);
    throw err;
  }

  const postHead = await resolveHead(cfg.git);
  if (preHead === null || postHead === null || preHead === postHead) {
    return { kind: "ok", changedPaths: [] };
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
  return { kind: "ok", changedPaths };
}

// Returns null for the unborn-HEAD case (fresh init, no commits yet).
// Other failures (corrupt refs, permission denied) surface — silently
// returning null would hide pull-produced changes.
async function resolveHead(git: SimpleGit): Promise<string | null> {
  try {
    const sha = await git.raw(["rev-parse", "HEAD"]);
    return sha.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /unknown revision|bad revision|does not have any commits yet/i.test(msg)
    ) {
      return null;
    }
    logger.error(`vault: rev-parse HEAD failed: ${msg}`);
    throw err;
  }
}
