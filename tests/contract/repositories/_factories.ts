import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultMemoryRepository } from "../../../src/backend/vault/repositories/memory-repository.js";
import { VaultWorkspaceRepository } from "../../../src/backend/vault/repositories/workspace-repository.js";
import type {
  MemoryRepository,
  WorkspaceRepository,
} from "../../../src/repositories/types.js";
import { getTestDb, truncateAll } from "../../helpers.js";

export interface TestBackend {
  name: "postgres" | "vault";
  memoryRepo: MemoryRepository;
  workspaceRepo: WorkspaceRepository;
  close(): Promise<void>;
}

export interface Factory {
  name: "postgres" | "vault";
  create(): Promise<TestBackend>;
}

// The pg backend uses the shared test DB. Each factory call truncates
// all tables first so tests see a clean slate without paying for a
// fresh connection pool per test.
export const pgFactory: Factory = {
  name: "postgres",
  async create() {
    const db = getTestDb();
    await truncateAll();
    const { DrizzleMemoryRepository } = await import(
      "../../../src/repositories/memory-repository.js"
    );
    const { DrizzleWorkspaceRepository } = await import(
      "../../../src/repositories/workspace-repository.js"
    );
    return {
      name: "postgres",
      memoryRepo: new DrizzleMemoryRepository(db),
      workspaceRepo: new DrizzleWorkspaceRepository(db),
      close: async () => {},
    };
  },
};

export const vaultFactory: Factory = {
  name: "vault",
  async create() {
    const root = await mkdtemp(join(tmpdir(), "contract-vault-"));
    const memoryRepo = await VaultMemoryRepository.create({ root });
    const workspaceRepo = new VaultWorkspaceRepository({ root });
    return {
      name: "vault",
      memoryRepo,
      workspaceRepo,
      close: async () => {
        await rm(root, { recursive: true, force: true });
      },
    };
  },
};

export const factories: Factory[] = [pgFactory, vaultFactory];
