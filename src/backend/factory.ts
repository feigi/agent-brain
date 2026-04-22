// src/backend/factory.ts
import type { BackendName, StorageBackend } from "./types.js";
import { PostgresBackend } from "./postgres/index.js";
import { VaultBackend } from "./vault/index.js";

export interface BackendConfig {
  backend: BackendName;
  databaseUrl: string;
  vaultRoot: string;
  vaultTrackUsersInGit?: boolean;
  embeddingDimensions: number;
}

export async function createBackend(
  config: BackendConfig,
): Promise<StorageBackend> {
  switch (config.backend) {
    case "postgres":
      return PostgresBackend.create(config.databaseUrl);
    case "vault":
      if (!config.vaultRoot) {
        throw new Error(
          "vault backend requires AGENT_BRAIN_VAULT_ROOT to be set",
        );
      }
      return VaultBackend.create({
        root: config.vaultRoot,
        embeddingDimensions: config.embeddingDimensions,
        trackUsersInGit: config.vaultTrackUsersInGit ?? false,
        remoteUrl: process.env.AGENT_BRAIN_VAULT_REMOTE_URL,
      });
    default: {
      // Exhaustiveness + runtime guard for an env-var typo that slipped past zod.
      const _exhaustive: never = config.backend;
      throw new Error(`unknown backend: ${String(_exhaustive)}`);
    }
  }
}
