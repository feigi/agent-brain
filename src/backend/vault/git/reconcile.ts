import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";
import { inferScopeFromPath } from "../io/paths.js";
import type { GitOps } from "./types.js";

export interface ReconcileConfig {
  git: SimpleGit;
  ops: GitOps;
}

export interface ReconcileResult {
  failed: boolean;
}

/**
 * Recovers from a crash between "markdown write succeeded" and "git commit
 * landed". Folds dirty tracked memory markdown into one `AB-Action: reconcile`
 * commit. Skips untracked files — auto-committing unreviewed markdown is
 * unsafe.
 */
export async function reconcileDirty(
  cfg: ReconcileConfig,
): Promise<ReconcileResult> {
  if (!cfg.ops.enabled) return { failed: false };
  const status = await cfg.git.status();
  const candidates = [...status.modified, ...status.deleted].filter(
    (p) => inferScopeFromPath(p) !== null,
  );
  if (candidates.length === 0) return { failed: false };

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
    return { failed: false };
  } catch (err) {
    logger.error(
      `vault reconcile commit failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { failed: true };
  }
}
