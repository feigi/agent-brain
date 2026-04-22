import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";
import { OFFLINE_RE } from "./pull.js";

const UNBORN_HEAD_RE =
  /unknown revision|bad revision|does not have any commits yet/i;
const UNKNOWN_REV_RE =
  /unknown revision|bad revision|ambiguous argument|Not a valid object name/i;

// Uses numeric `rev-list --count` rather than `merge-base --is-ancestor`
// so a transient git error cannot silently classify as "not ancestor"
// and trigger a destructive reset.
export async function alignWithRemote(git: SimpleGit): Promise<void> {
  const remotes = await git.getRemotes(true);
  if (!remotes.some((r) => r.name === "origin")) return;

  try {
    await git.fetch("origin");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (OFFLINE_RE.test(msg)) return;
    logger.error(`vault align: fetch failed with unexpected error: ${msg}`);
    throw err;
  }

  let remoteHead: string;
  try {
    remoteHead = (await git.raw(["rev-parse", "origin/main"])).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (UNKNOWN_REV_RE.test(msg)) return; // bare repo empty
    throw err;
  }

  let localHead: string | null;
  try {
    localHead = (await git.raw(["rev-parse", "HEAD"])).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!UNBORN_HEAD_RE.test(msg)) throw err;
    logger.info(`vault align: checkout main tracking origin/main`);
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

// Returns the merge-base SHA, or null when no common ancestor exists.
// Narrows the catch to exit-code 1 / empty stdout — corrupt-repo errors
// would otherwise silently route to the destructive unrelated-history
// branch.
async function tryMergeBase(
  git: SimpleGit,
  a: string,
  b: string,
): Promise<string | null> {
  try {
    const out = (await git.raw(["merge-base", a, b])).trim();
    return out === "" ? null : out;
  } catch (err) {
    const exit = (err as { exitCode?: number } | undefined)?.exitCode;
    if (exit === 1) return null;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`vault align: merge-base failed unexpectedly: ${msg}`);
    throw err;
  }
}
