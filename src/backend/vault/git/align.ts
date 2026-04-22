import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";

/**
 * Aligns the local repo with origin/main when local is behind remote or
 * the two histories are unrelated. Called once during VaultBackend
 * creation, before any push/pull logic runs.
 *
 * Ancestry is computed via `rev-list --count` (numeric) rather than
 * `merge-base --is-ancestor`, so transient git errors do not silently
 * classify as "not an ancestor" and trigger a destructive reset.
 *
 * Behaviour by case:
 *
 * 1. No `origin` remote configured → no-op (local-only vault).
 * 2. Origin unreachable (fetch throws) → no-op; offline handling
 *    deferred to the PushQueue / syncFromRemote path.
 * 3. origin/main does not yet exist (empty bare repo) → no-op; the
 *    first push from this vault will create it.
 * 4. No local commits yet → checks out a new `main` branch tracking
 *    `origin/main` directly.
 * 5. Local is up-to-date with or ahead of origin/main → no-op.
 * 6. Local is strictly behind remote → fast-forward:
 *    `reset --hard <remoteHead>` then
 *    `branch --set-upstream-to=origin/main main`.
 * 7. Histories have diverged AND share a common ancestor → throw. This
 *    is not a bootstrap scenario; destroying local work is unsafe.
 * 8. Histories have diverged AND share NO common ancestor (unrelated)
 *    → `reset --hard <remoteHead>` then set upstream. This is the
 *    fresh second-vault bootstrap case where both clones produced their
 *    own initial commits. Safe only at init time.
 *
 * Note: this function does NOT produce a merge commit. In case 6 and 8
 * it performs a hard reset to `origin/main` and sets the upstream
 * tracking branch.
 */
export async function alignWithRemote(git: SimpleGit): Promise<void> {
  const remotes = await git.getRemotes(true);
  if (!remotes.some((r) => r.name === "origin")) return;

  try {
    await git.fetch("origin");
  } catch {
    // Origin unreachable (offline); skip — pull will classify as offline.
    return;
  }

  let remoteHead: string;
  try {
    remoteHead = (await git.raw(["rev-parse", "origin/main"])).trim();
  } catch {
    // origin/main not found — bare repo is empty; nothing to align with.
    return;
  }

  let localHead: string | null;
  try {
    localHead = (await git.raw(["rev-parse", "HEAD"])).trim();
  } catch {
    // No local commits yet — track origin/main directly.
    await git.raw(["checkout", "-b", "main", "--track", "origin/main"]);
    return;
  }

  const ahead = await revListCount(git, `${remoteHead}..${localHead}`);
  const behind = await revListCount(git, `${localHead}..${remoteHead}`);

  if (behind === 0) return;
  if (ahead === 0) {
    await git.raw(["reset", "--hard", remoteHead]);
    await git.raw(["branch", "--set-upstream-to=origin/main", "main"]);
    return;
  }

  // Diverged — distinguish true unrelated histories (no common ancestor,
  // bootstrap case) from a shared-ancestor divergence (real local work).
  const mergeBase = await tryMergeBase(git, localHead, remoteHead);
  if (mergeBase !== null) {
    throw new Error(
      `vault: local HEAD ${localHead} has diverged from origin/main ${remoteHead} (ahead=${ahead}, behind=${behind}) with shared ancestor ${mergeBase}. Refusing destructive reset; resolve manually or reconfigure AGENT_BRAIN_VAULT_REMOTE_URL.`,
    );
  }

  logger.error(
    `vault: unrelated-history reset — local HEAD ${localHead} has no common ancestor with origin/main ${remoteHead}; discarding local history. This is safe only for fresh-clone bootstrap; if you have local work, abort and investigate AGENT_BRAIN_VAULT_REMOTE_URL.`,
  );
  await git.raw(["reset", "--hard", remoteHead]);
  await git.raw(["branch", "--set-upstream-to=origin/main", "main"]);
}

async function revListCount(git: SimpleGit, range: string): Promise<number> {
  const out = await git.raw(["rev-list", "--count", range]);
  const n = Number(out.trim());
  if (!Number.isFinite(n)) {
    throw new Error(`vault: rev-list --count ${range} returned ${out.trim()}`);
  }
  return n;
}

/** Returns the merge-base SHA, or null when no common ancestor exists. */
async function tryMergeBase(
  git: SimpleGit,
  a: string,
  b: string,
): Promise<string | null> {
  try {
    const out = (await git.raw(["merge-base", a, b])).trim();
    return out === "" ? null : out;
  } catch {
    // `git merge-base` exits non-zero when there is no common ancestor.
    return null;
  }
}
