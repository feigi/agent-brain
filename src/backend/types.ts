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

// Absent field = healthy. Zero/false values are stripped before merging
// into envelope meta so clients treat absence as the healthy state.
export interface BackendSessionStartMeta {
  offline?: true;
  unpushed_commits?: number;
  pull_conflict?: true;
  // Files whose frontmatter or body can't be parsed into a valid Memory.
  // Each entry carries the vault-relative path and a human-readable reason
  // so the UI can surface *why* without forcing the user to open logs.
  // Absent when everything parses.
  parse_errors?: Array<{ path: string; reason: string }>;
  // Last push failure message; set while push-queue is in backoff so
  // users can tell "not pushed yet" from "broken auth / bad remote".
  last_push_error?: string;
  // Dirty-tree reconcile commit on boot failed; next write will try again.
  reconcile_failed?: true;
  // `rebase --abort` itself failed after a conflict; working tree may be
  // wedged mid-rebase. Signals the operator to inspect manually.
  rebase_wedged?: true;
  // `AGENT_BRAIN_VAULT_REMOTE_URL` disagrees with configured `origin`;
  // operator intent wins but surface it so the mismatch is visible.
  remote_mismatch?: { configured: string; actual: string };
  // Chokidar watcher emitted an 'error' event during this process's
  // lifetime. Sticky from first occurrence to process restart. Surfaces
  // here so clients can show a degraded-mode banner — watcher does NOT
  // auto-restart (silent-failure risk).
  watcher_error?: true;
}

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
  sessionStart(): Promise<BackendSessionStartMeta>;
}
