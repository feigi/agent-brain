import { mkdir } from "node:fs/promises";
import { VaultAuditRepository } from "./repositories/audit-repository.js";
import { VaultCommentRepository } from "./repositories/comment-repository.js";
import { VaultFlagRepository } from "./repositories/flag-repository.js";
import { VaultMemoryRepository } from "./repositories/memory-repository.js";
import { VaultRelationshipRepository } from "./repositories/relationship-repository.js";
import { VaultSchedulerStateRepository } from "./repositories/scheduler-state-repository.js";
import { VaultSessionRepository } from "./repositories/session-repository.js";
import { VaultSessionTrackingRepository } from "./repositories/session-tracking-repository.js";
import { VaultWorkspaceRepository } from "./repositories/workspace-repository.js";
import type { BackendName, StorageBackend } from "../types.js";
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
}

// Markdown-vault backend. Composes the nine Vault* repositories backed
// by files under a single root directory. All IO is per-op, so close()
// is a no-op — there's no connection pool to drain.
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

  private constructor(memoryRepo: MemoryRepository, root: string) {
    this.memoryRepo = memoryRepo;
    this.workspaceRepo = new VaultWorkspaceRepository({ root });
    this.commentRepo = new VaultCommentRepository({ root });
    this.sessionRepo = new VaultSessionTrackingRepository({ root });
    this.sessionLifecycleRepo = new VaultSessionRepository({ root });
    this.auditRepo = new VaultAuditRepository({ root });
    this.flagRepo = new VaultFlagRepository({ root });
    this.relationshipRepo = new VaultRelationshipRepository({ root });
    this.schedulerStateRepo = new VaultSchedulerStateRepository({ root });
  }

  static async create(cfg: VaultBackendConfig): Promise<VaultBackend> {
    await mkdir(cfg.root, { recursive: true });
    const memoryRepo = await VaultMemoryRepository.create({ root: cfg.root });
    return new VaultBackend(memoryRepo, cfg.root);
  }

  async close(): Promise<void> {}
}
