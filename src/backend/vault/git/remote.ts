import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";

export interface EnsureRemoteConfig {
  git: SimpleGit;
  remoteUrl?: string;
}

export interface EnsureRemoteResult {
  mismatch?: { configured: string; actual: string };
}

// Leave existing origin in place — operator intent wins; mismatch is
// surfaced via boot meta so the operator sees it without digging through
// logs.
export async function ensureRemote(
  cfg: EnsureRemoteConfig,
): Promise<EnsureRemoteResult> {
  const remotes = await cfg.git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  if (origin) {
    if (cfg.remoteUrl && origin.refs.fetch !== cfg.remoteUrl) {
      logger.warn(
        `vault: configured remoteUrl (${cfg.remoteUrl}) differs from existing origin (${origin.refs.fetch}); leaving existing`,
      );
      return {
        mismatch: { configured: cfg.remoteUrl, actual: origin.refs.fetch },
      };
    }
    return {};
  }
  if (!cfg.remoteUrl) return {};
  await cfg.git.addRemote("origin", cfg.remoteUrl);
  return {};
}
