// src/backend/factory.ts
import type { BackendName, StorageBackend } from "./types.js";
import { PostgresBackend } from "./postgres/index.js";

export interface BackendConfig {
  backend: BackendName;
  databaseUrl: string;
}

/**
 * Select and construct the configured storage backend.
 *
 * Phase 0 only ships the postgres backend. The vault backend is
 * declared in the type enum so downstream code can already switch on
 * it, but `createBackend({ backend: "vault" })` throws until Phase 1+
 * lands the implementation.
 */
export async function createBackend(
  config: BackendConfig,
): Promise<StorageBackend> {
  switch (config.backend) {
    case "postgres":
      return PostgresBackend.create(config.databaseUrl);
    case "vault":
      throw new Error(
        "vault backend is not yet implemented — set AGENT_BRAIN_BACKEND=postgres",
      );
    default: {
      // Exhaustiveness + runtime guard for an env-var typo that slipped past zod.
      const _exhaustive: never = config.backend;
      throw new Error(`unknown backend: ${String(_exhaustive)}`);
    }
  }
}
