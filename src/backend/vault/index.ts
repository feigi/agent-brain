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
import { VaultIndex } from "./repositories/vault-index.js";
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
import type { PathConsistencyChecker } from "../../services/consolidation-service.js";
import type { ParseErrorChecker } from "../../services/consolidation-service.js";
import { VaultParseErrorChecker } from "./parse-error-checker.js";
import type { FlagService } from "../../services/flag-service.js";
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
  // Concrete type needed — syncPaths isn't on MemoryRepository.
  private readonly vaultMemoryRepo: VaultMemoryRepository;

  private constructor(
    memoryRepo: VaultMemoryRepository,
    private readonly vectorIndex: VaultVectorIndex,
    private readonly vaultIdx: VaultIndex,
    private readonly root: string,
    gitOps: GitOps,
    trackUsersInGit: boolean,
    private readonly git: SimpleGit,
    private readonly pushQueue: PushQueue,
    private readonly embed: Embedder,
    private readonly bootMeta: Partial<BackendSessionStartMeta>,
  ) {
    this.memoryRepo = memoryRepo;
    this.vaultMemoryRepo = memoryRepo;
    this.workspaceRepo = new VaultWorkspaceRepository({ root, gitOps });
    this.commentRepo = new VaultCommentRepository({
      root,
      gitOps,
      trackUsersInGit,
      vaultIndex: vaultIdx,
    });
    this.sessionRepo = new VaultSessionTrackingRepository({ root });
    this.sessionLifecycleRepo = new VaultSessionRepository({ root });
    this.auditRepo = new VaultAuditRepository({
      root,
      git: this.git,
    });
    this.flagRepo = new VaultFlagRepository({
      root,
      gitOps,
      trackUsersInGit,
      vaultIndex: vaultIdx,
    });
    this.relationshipRepo = new VaultRelationshipRepository({
      root,
      gitOps,
      trackUsersInGit,
      vaultIndex: vaultIdx,
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
    const bootMeta: Partial<BackendSessionStartMeta> = {};
    const remoteResult = await ensureRemote({ git, remoteUrl: cfg.remoteUrl });
    if (remoteResult.mismatch) bootMeta.remote_mismatch = remoteResult.mismatch;

    const gitOps: GitOps = new GitOpsImpl({ root: cfg.root });
    // Reconcile BEFORE align: a post-crash dirty tree must land as a
    // commit first, otherwise align's `reset --hard` on the
    // unrelated-history bootstrap path silently discards it.
    const reconcile = await reconcileDirty({ git, ops: gitOps });
    if (reconcile.failed) bootMeta.reconcile_failed = true;
    await alignWithRemote(git);

    const vectorIndex = await VaultVectorIndex.create({
      root: cfg.root,
      dims: cfg.embeddingDimensions,
    });

    const debounceMs = cfg.pushDebounceMs ?? 5000;
    // Backoff: fast first retry for transient blips, then exponential to
    // a 30-min cap so we don't tight-loop against a broken remote.
    const backoffMs = cfg.pushBackoffMs ?? [5000, 30000, 300000, 1800000];
    const pushQueue = new PushQueue({
      debounceMs,
      backoffMs,
      push: async () => {
        // --set-upstream so @{u} resolves on subsequent calls and the
        // unpushed-count query works post-first-push.
        await git.raw(["push", "--set-upstream", "origin", "HEAD:main"]);
      },
      countUnpushed: async () => {
        // Throws pre-first-push when @{u} is unset — caller classifies.
        const out = await git.raw(["rev-list", "--count", "@{u}..HEAD"]);
        const n = Number.parseInt(out.trim(), 10);
        if (!Number.isFinite(n)) {
          throw new Error(`rev-list --count returned ${out.trim()}`);
        }
        return n;
      },
    });

    if (gitOps.enabled) {
      gitOps.afterCommit = () => pushQueue.request();
    }

    const vaultIdx = await VaultIndex.create(cfg.root);

    const memoryRepo = VaultMemoryRepository.create({
      root: cfg.root,
      vectorIndex: vectorIndex,
      gitOps,
      trackUsersInGit,
      vaultIndex: vaultIdx,
    });

    const embed = cfg.embed ?? defaultEmbedder(cfg.embeddingDimensions);

    return new VaultBackend(
      memoryRepo,
      vectorIndex,
      vaultIdx,
      cfg.root,
      gitOps,
      trackUsersInGit,
      git,
      pushQueue,
      embed,
      bootMeta,
    );
  }

  async close(): Promise<void> {
    await this.pushQueue.close();
    await this.vectorIndex.close();
  }

  /** Returns a PathConsistencyChecker backed by this vault's index. */
  get pathConsistencyChecker(): PathConsistencyChecker {
    const vaultIdx = this.vaultIdx;
    return {
      check: async () => vaultIdx.checkPathConsistency(),
    };
  }

  createParseErrorChecker(flagService: FlagService): ParseErrorChecker {
    return new VaultParseErrorChecker(this.vaultIdx, this.root, flagService);
  }

  /**
   * Waits until all pending pushes have landed on the remote.
   * Polls git until `@{u}..HEAD` is empty (no unpushed commits).
   * Used by integration tests to synchronise after a write.
   */
  async flushPushes(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      try {
        await this.git.raw(["rev-parse", "@{u}"]);
        const out = await this.git.raw(["rev-list", "--count", "@{u}..HEAD"]);
        if (Number(out.trim()) === 0) return;
      } catch {
        // @{u} not yet set — first push hasn't landed. Keep polling.
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      "flushPushes: timed out waiting for push to settle (@{u} set + 0 unpushed)",
    );
  }

  /**
   * Pulls from remote.
   * - `conflict`: true when a rebase conflict could not be auto-resolved.
   * - `offline`: true when the remote was unreachable (network/auth); the
   *   local state is unchanged and the caller can continue serving local data.
   */
  async pullFromRemote(): Promise<{ conflict: boolean; offline: boolean }> {
    const res = await syncFromRemote({ git: this.git });
    if (res.kind === "ok") {
      // Notify path-index of pulled changes so findById stays accurate.
      await this.vaultMemoryRepo.syncPaths(res.changedPaths);
    }
    return {
      conflict: res.kind === "conflict",
      offline: res.kind === "offline",
    };
  }

  async sessionStart(): Promise<BackendSessionStartMeta> {
    const meta = await runSessionStart({
      root: this.root,
      vectorIndex: this.vectorIndex,
      embed: this.embed,
      syncFromRemote: () => syncFromRemote({ git: this.git }),
      pushQueue: {
        unpushedCommits: () => this.pushQueue.unpushedCommits(),
        lastPushError: () => this.pushQueue.lastPushError(),
        request: () => this.pushQueue.request(),
      },
      onChangedPaths: async (paths) => {
        // Pulled files need path-index refresh or findById misses until restart.
        await this.vaultMemoryRepo.syncPaths(paths);
      },
      unindexablePaths: this.vaultIdx.unindexable.map(u => u.path),
    });
    // Boot-time meta (remote_mismatch, reconcile_failed) is sticky for
    // the life of the backend — clients should see it on every session
    // start until the process is restarted with a fixed config.
    if (this.bootMeta.remote_mismatch)
      meta.remote_mismatch = this.bootMeta.remote_mismatch;
    if (this.bootMeta.reconcile_failed) meta.reconcile_failed = true;
    return meta;
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
