import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";

export interface EnsureRemoteConfig {
  git: SimpleGit;
  remoteUrl?: string;
}

/**
 * Adds `origin` to the vault repo when absent and `remoteUrl` is provided.
 * Leaves any existing `origin` alone — users may have configured the
 * remote manually and that intent wins. Mismatches are warn-logged.
 * Idempotent.
 */
export async function ensureRemote(cfg: EnsureRemoteConfig): Promise<void> {
  const remotes = await cfg.git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  if (origin) {
    if (cfg.remoteUrl && origin.refs.fetch !== cfg.remoteUrl) {
      logger.warn(
        `vault: configured remoteUrl (${cfg.remoteUrl}) differs from existing origin (${origin.refs.fetch}); leaving existing`,
      );
    }
    return;
  }
  if (!cfg.remoteUrl) return;
  await cfg.git.addRemote("origin", cfg.remoteUrl);
}
