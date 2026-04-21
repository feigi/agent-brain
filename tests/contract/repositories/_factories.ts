import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultMemoryRepository } from "../../../src/backend/vault/repositories/memory-repository.js";
import { VaultWorkspaceRepository } from "../../../src/backend/vault/repositories/workspace-repository.js";
import { VaultAuditRepository } from "../../../src/backend/vault/repositories/audit-repository.js";
import { VaultSchedulerStateRepository } from "../../../src/backend/vault/repositories/scheduler-state-repository.js";
import { VaultSessionTrackingRepository } from "../../../src/backend/vault/repositories/session-tracking-repository.js";
import { VaultSessionRepository } from "../../../src/backend/vault/repositories/session-repository.js";
import { VaultCommentRepository } from "../../../src/backend/vault/repositories/comment-repository.js";
import { VaultFlagRepository } from "../../../src/backend/vault/repositories/flag-repository.js";
import { VaultRelationshipRepository } from "../../../src/backend/vault/repositories/relationship-repository.js";
import type {
  AuditRepository,
  CommentRepository,
  FlagRepository,
  MemoryRepository,
  RelationshipRepository,
  SchedulerStateRepository,
  SessionRepository,
  SessionTrackingRepository,
  WorkspaceRepository,
} from "../../../src/repositories/types.js";
import { getTestDb, truncateAll } from "../../helpers.js";

export interface TestBackend {
  name: "postgres" | "vault";
  memoryRepo: MemoryRepository;
  workspaceRepo: WorkspaceRepository;
  auditRepo: AuditRepository;
  schedulerStateRepo: SchedulerStateRepository;
  sessionTrackingRepo: SessionTrackingRepository;
  sessionRepo: SessionRepository;
  commentRepo: CommentRepository;
  flagRepo: FlagRepository;
  relationshipRepo: RelationshipRepository;
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
    const { DrizzleMemoryRepository } =
      await import("../../../src/repositories/memory-repository.js");
    const { DrizzleWorkspaceRepository } =
      await import("../../../src/repositories/workspace-repository.js");
    const { DrizzleAuditRepository } =
      await import("../../../src/repositories/audit-repository.js");
    const { DrizzleSchedulerStateRepository } =
      await import("../../../src/repositories/scheduler-state-repository.js");
    const { DrizzleSessionTrackingRepository, DrizzleSessionRepository } =
      await import("../../../src/repositories/session-repository.js");
    const { DrizzleCommentRepository } =
      await import("../../../src/repositories/comment-repository.js");
    const { DrizzleFlagRepository } =
      await import("../../../src/repositories/flag-repository.js");
    const { DrizzleRelationshipRepository } =
      await import("../../../src/repositories/relationship-repository.js");
    return {
      name: "postgres",
      memoryRepo: new DrizzleMemoryRepository(db),
      workspaceRepo: new DrizzleWorkspaceRepository(db),
      auditRepo: new DrizzleAuditRepository(db),
      schedulerStateRepo: new DrizzleSchedulerStateRepository(db),
      sessionTrackingRepo: new DrizzleSessionTrackingRepository(db),
      sessionRepo: new DrizzleSessionRepository(db),
      commentRepo: new DrizzleCommentRepository(db),
      flagRepo: new DrizzleFlagRepository(db),
      relationshipRepo: new DrizzleRelationshipRepository(db),
      close: async () => {},
    };
  },
};

export const vaultFactory: Factory = {
  name: "vault",
  async create() {
    const root = await mkdtemp(join(tmpdir(), "contract-vault-"));
    const { VaultVectorIndex } =
      await import("../../../src/backend/vault/vector/lance-index.js");
    const index = await VaultVectorIndex.create({ root, dims: 768 });
    const memoryRepo = await VaultMemoryRepository.create({ root, index });
    const workspaceRepo = new VaultWorkspaceRepository({ root });
    const auditRepo = new VaultAuditRepository({ root });
    const schedulerStateRepo = new VaultSchedulerStateRepository({ root });
    const sessionTrackingRepo = new VaultSessionTrackingRepository({ root });
    const sessionRepo = new VaultSessionRepository({ root });
    const commentRepo = new VaultCommentRepository({ root });
    const flagRepo = new VaultFlagRepository({ root });
    const relationshipRepo = new VaultRelationshipRepository({ root });
    return {
      name: "vault",
      memoryRepo,
      workspaceRepo,
      auditRepo,
      schedulerStateRepo,
      sessionTrackingRepo,
      sessionRepo,
      commentRepo,
      flagRepo,
      relationshipRepo,
      close: async () => {
        await index.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  },
};

export const factories: Factory[] = [pgFactory, vaultFactory];
