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
}
