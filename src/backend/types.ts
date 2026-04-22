// src/backend/types.ts
import type {
  MemoryRepository,
  WorkspaceRepository,
  CommentRepository,
  SessionTrackingRepository,
  SessionRepository,
  AuditRepository,
  FlagRepository,
  RelationshipRepository,
  SchedulerStateRepository,
} from "../repositories/types.js";

export type BackendName = "postgres" | "vault";

/**
 * Envelope meta fields contributed by the backend at memory_session_start.
 * All fields optional — absent means healthy. Merged into the MemoryService
 * session-start envelope meta. The pg backend always returns {}; vault
 * populates based on pull + push-queue state.
 */
export interface BackendSessionStartMeta {
  /** Literal `true` — presence means offline; `false` is not a valid state. */
  offline?: true;
  unpushed_commits?: number;
  /** Literal `true` — presence means a rebase conflict was detected. */
  pull_conflict?: true;
  parse_errors?: number;
}

/**
 * Storage backend abstraction. Bundles the eight repository interfaces
 * plus a lifecycle hook. `server.ts` constructs one of these via
 * `createBackend()` and passes the individual repos to services.
 *
 * New backends (e.g. vault) implement this interface without touching
 * service or tool code.
 */
export interface StorageBackend {
  readonly name: BackendName;
  readonly memoryRepo: MemoryRepository;
  readonly workspaceRepo: WorkspaceRepository;
  readonly commentRepo: CommentRepository;
  readonly sessionRepo: SessionTrackingRepository;
  readonly sessionLifecycleRepo: SessionRepository;
  readonly auditRepo: AuditRepository;
  readonly flagRepo: FlagRepository;
  readonly relationshipRepo: RelationshipRepository;
  readonly schedulerStateRepo: SchedulerStateRepository;
  close(): Promise<void>;
  /**
   * Called by MemoryService.sessionStart before composing the response.
   * Backend-specific sync/reconciliation. Returned fields merge into
   * envelope meta.
   */
  sessionStart(): Promise<BackendSessionStartMeta>;
}
