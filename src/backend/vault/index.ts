import { mkdir } from "node:fs/promises";
import { simpleGit, type SimpleGit } from "simple-git";
import { VaultAuditRepository } from "./repositories/audit-repository.js";
import { VaultCommentRepository } from "./repositories/comment-repository.js";
import { VaultFlagRepository } from "./repositories/flag-repository.js";
import { VaultMemoryRepository } from "./repositories/memory-repository.js";
import { VaultRelationshipRepository } from "./repositories/relationship-repository.js";
import { VaultSchedulerStateRepository } from "./repositories/scheduler-state-repository.js";
import { VaultSessionRepository } from "./repositories/session-repository.js";
import { VaultSessionTrackingRepository } from "./repositories/session-tracking-repository.js";
import { VaultWorkspaceRepository } from "./repositories/workspace-repository.js";
import { VaultVectorIndex } from "./vector/lance-index.js";
import { ensureVaultGit } from "./git/bootstrap.js";
import { GitOpsImpl } from "./git/git-ops.js";
import { scrubGitEnv } from "./git/env.js";
import { ensureRemote } from "./git/remote.js";
import { reconcileDirty } from "./git/reconcile.js";
import { syncFromRemote } from "./git/pull.js";
import { PushQueue } from "./git/push-queue.js";
import { alignWithRemote } from "./git/align.js";
import type { GitOps } from "./git/types.js";
import { runSessionStart } from "./session-start.js";
import type { Embedder } from "./session-start.js";
import { createEmbeddingProvider } from "../../providers/embedding/index.js";
import type {
  BackendName,
  StorageBackend,
  BackendSessionStartMeta,
} from "../types.js";
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
} from "../../repositories/types.js";

export interface VaultBackendConfig {
  root: string;
  embeddingDimensions: number;
  // When true, user-scope memories are committed to git alongside
  // workspace/project ones. Default false — `users/` stays gitignored
  // and its writes skip the commit step (privacy-first).
  trackUsersInGit?: boolean;
  remoteUrl?: string;
  pushDebounceMs?: number;
  pushBackoffMs?: readonly number[];
  embed?: Embedder;
}

// Markdown-vault backend. Composes the nine Vault* repositories backed
// by files under a single root directory, plus a LanceDB-backed vector
// index under <root>/.agent-brain/index.lance. close() disposes the
// vector index; markdown IO is per-op and needs no teardown.
export class VaultBackend implements StorageBackend {
  readonly name: BackendName = "vault";
  readonly memoryRepo: MemoryRepository;
  readonly workspaceRepo: WorkspaceRepository;
  readonly commentRepo: CommentRepository;
  readonly sessionRepo: SessionTrackingRepository;
  readonly sessionLifecycleRepo: SessionRepository;
  readonly auditRepo: AuditRepository;
  readonly flagRepo: FlagRepository;
  readonly relationshipRepo: RelationshipRepository;
  readonly schedulerStateRepo: SchedulerStateRepository;
  // Retain the concrete type so sessionStart can call syncPaths()
  // after a pull without a type cast.
  private readonly vaultMemoryRepo: VaultMemoryRepository;

  private constructor(
    memoryRepo: VaultMemoryRepository,
    private readonly vectorIndex: VaultVectorIndex,
    private readonly root: string,
    gitOps: GitOps,
    trackUsersInGit: boolean,
    private readonly git: SimpleGit,
    private readonly pushQueue: PushQueue,
    private readonly embed: Embedder,
  ) {
    this.memoryRepo = memoryRepo;
    this.vaultMemoryRepo = memoryRepo;
    this.workspaceRepo = new VaultWorkspaceRepository({ root, gitOps });
    this.commentRepo = new VaultCommentRepository({
      root,
      gitOps,
      trackUsersInGit,
    });
    this.sessionRepo = new VaultSessionTrackingRepository({ root });
    this.sessionLifecycleRepo = new VaultSessionRepository({ root });
    this.auditRepo = new VaultAuditRepository({ root });
    this.flagRepo = new VaultFlagRepository({
      root,
      gitOps,
      trackUsersInGit,
    });
    this.relationshipRepo = new VaultRelationshipRepository({
      root,
      gitOps,
      trackUsersInGit,
    });
    this.schedulerStateRepo = new VaultSchedulerStateRepository({ root });
  }

  static async create(cfg: VaultBackendConfig): Promise<VaultBackend> {
    await mkdir(cfg.root, { recursive: true });
    const trackUsersInGit = cfg.trackUsersInGit ?? false;
    await ensureVaultGit({
      root: cfg.root,
      trackUsers: trackUsersInGit,
    });
    const git = simpleGit({ baseDir: cfg.root }).env(scrubGitEnv());
    await ensureRemote({ git, remoteUrl: cfg.remoteUrl });
    await alignWithRemote(git);

    const gitOps: GitOps = new GitOpsImpl({ root: cfg.root });
    await reconcileDirty({ git, ops: gitOps });

    const vectorIndex = await VaultVectorIndex.create({
      root: cfg.root,
      dims: cfg.embeddingDimensions,
    });

    const debounceMs = cfg.pushDebounceMs ?? 5000;
    const backoffMs = cfg.pushBackoffMs ?? [5000, 30000, 300000, 1800000];
    const pushQueue = new PushQueue({
      debounceMs,
      backoffMs,
      push: async () => {
        // --set-upstream ensures @{u} resolves on subsequent calls so
        // `git rev-list --count @{u}..HEAD` works after the first push.
        await git.raw(["push", "--set-upstream", "origin", "HEAD:main"]);
      },
      countUnpushed: async () => {
        // Throws when @{u} is not yet configured (pre-first-push). The
        // PushQueue.unpushedCommits() wrapper logs and returns 0 for that
        // and any other failure.
        const out = await git.raw(["rev-list", "--count", "@{u}..HEAD"]);
        return Number(out.trim()) || 0;
      },
    });

    if (gitOps.enabled) {
      gitOps.afterCommit = () => pushQueue.request();
    }

    const memoryRepo = await VaultMemoryRepository.create({
      root: cfg.root,
      index: vectorIndex,
      gitOps,
      trackUsersInGit,
    });

    const embed = cfg.embed ?? defaultEmbedder(cfg.embeddingDimensions);

    return new VaultBackend(
      memoryRepo,
      vectorIndex,
      cfg.root,
      gitOps,
      trackUsersInGit,
      git,
      pushQueue,
      embed,
    );
  }

  async close(): Promise<void> {
    await this.pushQueue.close();
    await this.vectorIndex.close();
  }

  async sessionStart(): Promise<BackendSessionStartMeta> {
    return runSessionStart({
      root: this.root,
      vectorIndex: this.vectorIndex,
      embed: this.embed,
      syncFromRemote: () => syncFromRemote({ git: this.git }),
      pushQueue: {
        unpushedCommits: () => this.pushQueue.unpushedCommits(),
        request: () => this.pushQueue.request(),
      },
      onChangedPaths: (paths) => {
        // Keep the memory repo's in-memory path index in sync with
        // files that arrived via git pull so findById works immediately
        // after sessionStart without a full process restart.
        this.vaultMemoryRepo.syncPaths(paths);
      },
    });
  }
}

function defaultEmbedder(dims: number): Embedder {
  const provider = createEmbeddingProvider();
  return async (text: string) => {
    const vec = await provider.embed(text);
    if (vec.length !== dims) {
      throw new Error(
        `vault embed: provider returned ${vec.length} dims, expected ${dims}`,
      );
    }
    return vec;
  };
}
