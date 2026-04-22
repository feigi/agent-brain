import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";
import type { GitOps } from "./types.js";

export interface ReconcileConfig {
  git: SimpleGit;
  ops: GitOps;
}

const MEMORY_PATH_RE =
  /^(workspaces\/[^/]+\/memories\/|project\/memories\/|users\/[^/]+\/memories\/).+\.md$/;

/**
 * Recovers from a crash between "markdown write succeeded" and "git commit
 * landed". Collects dirty tracked memory markdown files and folds them
 * into a single commit with trailer `AB-Action: reconcile`.
 *
 * Only modified and deleted tracked files are included. Untracked files
 * are skipped — auto-committing unreviewed markdown on startup is unsafe.
 * Non-memory dirty files are also ignored so operator edits to README
 * etc. are never swept up by agent-brain.
 */
export async function reconcileDirty(cfg: ReconcileConfig): Promise<void> {
  if (!cfg.ops.enabled) return;
  const status = await cfg.git.status();
  // Use only modified and deleted — not_added is untracked and must be
  // skipped (untracked markdown requires validation before auto-commit).
  const candidates = [...status.modified, ...status.deleted].filter((p) =>
    MEMORY_PATH_RE.test(p),
  );
  if (candidates.length === 0) return;

  try {
    await cfg.ops.stageAndCommit(
      candidates,
      "[agent-brain] reconcile: post-crash recovery",
      {
        action: "reconcile",
        actor: "agent-brain",
        reason: "post-crash-recovery",
      },
    );
  } catch (err) {
    logger.error(
      `vault reconcile commit failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
