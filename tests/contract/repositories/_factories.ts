import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { VaultMemoryRepository } from "../../../src/backend/vault/repositories/memory-repository.js";
import { VaultWorkspaceRepository } from "../../../src/backend/vault/repositories/workspace-repository.js";
import { VaultAuditRepository } from "../../../src/backend/vault/repositories/audit-repository.js";
import { VaultSchedulerStateRepository } from "../../../src/backend/vault/repositories/scheduler-state-repository.js";
import { VaultSessionTrackingRepository } from "../../../src/backend/vault/repositories/session-tracking-repository.js";
import { VaultSessionRepository } from "../../../src/backend/vault/repositories/session-repository.js";
import { VaultCommentRepository } from "../../../src/backend/vault/repositories/comment-repository.js";
import { VaultFlagRepository } from "../../../src/backend/vault/repositories/flag-repository.js";
import { VaultRelationshipRepository } from "../../../src/backend/vault/repositories/relationship-repository.js";
import { VaultIndex } from "../../../src/backend/vault/repositories/vault-index.js";
import { ensureVaultGit } from "../../../src/backend/vault/git/bootstrap.js";
import { GitOpsImpl } from "../../../src/backend/vault/git/git-ops.js";
import { scrubGitEnv } from "../../../src/backend/vault/git/env.js";
import { NOOP_GIT_OPS } from "../../../src/backend/vault/git/types.js";
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
  // Populated by the vault-git factory; pg + vault (no-git) leave it undefined.
  gitRoot?: string;
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
    const vectorIndex = await VaultVectorIndex.create({ root, dims: 768 });
    const vaultIndex = await VaultIndex.create(root);
    const gitOps = NOOP_GIT_OPS;
    const memoryRepo = VaultMemoryRepository.create({
      root,
      vectorIndex,
      gitOps,
      vaultIndex,
    });
    const workspaceRepo = new VaultWorkspaceRepository({ root, gitOps });
    // VaultAuditRepository reads git log, so it needs an actual git repo
    // even when other repos use NOOP_GIT_OPS. A bare `git init` (no commits)
    // is sufficient: `git log` on an empty repo returns "" → findByMemoryId
    // returns [] for all IDs, which is correct for the one contract test that
    // runs against vault ("findByMemoryId returns empty array for unknown memory").
    const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
    await git.init();
    await git.addConfig("user.email", "contract@example.com");
    await git.addConfig("user.name", "Contract Test");
    const auditRepo = new VaultAuditRepository({ root, git });
    const schedulerStateRepo = new VaultSchedulerStateRepository({ root });
    const sessionTrackingRepo = new VaultSessionTrackingRepository({ root });
    const sessionRepo = new VaultSessionRepository({ root });
    const commentRepo = new VaultCommentRepository({
      root,
      gitOps,
      vaultIndex,
    });
    const flagRepo = new VaultFlagRepository({ root, gitOps, vaultIndex });
    const relationshipRepo = new VaultRelationshipRepository({
      root,
      gitOps,
      vaultIndex,
    });
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
        await vectorIndex.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  },
};

export const factories: Factory[] = [pgFactory, vaultFactory];

// Parallel to vaultFactory but initializes a real git repo inside the
// vault root and injects GitOpsImpl. Used only by the *-git.test.ts
// suites that assert commit behavior. Keeping this separate avoids
// paying the git-init cost on every contract test.
export function makeVaultGitFactory(
  opts: { trackUsersInGit?: boolean } = {},
): Factory {
  const trackUsersInGit = opts.trackUsersInGit ?? false;
  return {
    name: "vault",
    async create() {
      const root = await mkdtemp(join(tmpdir(), "contract-vault-git-"));
      await ensureVaultGit({ root, trackUsers: trackUsersInGit });
      const cfgGit = simpleGit({ baseDir: root }).env(scrubGitEnv());
      await cfgGit.addConfig("user.email", "contract@example.com");
      await cfgGit.addConfig("user.name", "Contract Test");
      const gitOps = new GitOpsImpl({ root });
      const { VaultVectorIndex } =
        await import("../../../src/backend/vault/vector/lance-index.js");
      const vectorIndex = await VaultVectorIndex.create({ root, dims: 768 });
      const vaultIndex = await VaultIndex.create(root);
      const memoryRepo = VaultMemoryRepository.create({
        root,
        vectorIndex,
        gitOps,
        trackUsersInGit,
        vaultIndex,
      });
      const workspaceRepo = new VaultWorkspaceRepository({ root, gitOps });
      const auditRepo = new VaultAuditRepository({
        root,
        git: cfgGit,
      });
      const schedulerStateRepo = new VaultSchedulerStateRepository({ root });
      const sessionTrackingRepo = new VaultSessionTrackingRepository({ root });
      const sessionRepo = new VaultSessionRepository({ root });
      const commentRepo = new VaultCommentRepository({
        root,
        gitOps,
        trackUsersInGit,
        vaultIndex,
      });
      const flagRepo = new VaultFlagRepository({
        root,
        gitOps,
        trackUsersInGit,
        vaultIndex,
      });
      const relationshipRepo = new VaultRelationshipRepository({
        root,
        gitOps,
        trackUsersInGit,
        vaultIndex,
      });
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
        gitRoot: root,
        close: async () => {
          await vectorIndex.close();
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  };
}

export const vaultGitFactory: Factory = makeVaultGitFactory();
