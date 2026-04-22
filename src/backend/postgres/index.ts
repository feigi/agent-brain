// src/backend/postgres/index.ts
import { createDb, type Database } from "../../db/index.js";
import { runMigrations } from "../../db/migrate.js";
import { DrizzleMemoryRepository } from "../../repositories/memory-repository.js";
import { DrizzleWorkspaceRepository } from "../../repositories/workspace-repository.js";
import { DrizzleCommentRepository } from "../../repositories/comment-repository.js";
import {
  DrizzleSessionTrackingRepository,
  DrizzleSessionRepository,
} from "../../repositories/session-repository.js";
import { DrizzleAuditRepository } from "../../repositories/audit-repository.js";
import { DrizzleFlagRepository } from "../../repositories/flag-repository.js";
import { DrizzleRelationshipRepository } from "../../repositories/relationship-repository.js";
import { DrizzleSchedulerStateRepository } from "../../repositories/scheduler-state-repository.js";
import type {
  StorageBackend,
  BackendName,
  BackendSessionStartMeta,
} from "../types.js";
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
} from "../../repositories/types.js";

/**
 * Postgres + pgvector backend. Holds the drizzle Database handle and the
 * eight Drizzle* repository instances. `close()` ends the postgres-js
 * connection pool.
 *
 * Construct via `PostgresBackend.create(databaseUrl)` — it runs migrations
 * before returning, matching the prior inline behavior in `server.ts`.
 */
export class PostgresBackend implements StorageBackend {
  readonly name: BackendName = "postgres";
  readonly memoryRepo: MemoryRepository;
  readonly workspaceRepo: WorkspaceRepository;
  readonly commentRepo: CommentRepository;
  readonly sessionRepo: SessionTrackingRepository;
  readonly sessionLifecycleRepo: SessionRepository;
  readonly auditRepo: AuditRepository;
  readonly flagRepo: FlagRepository;
  readonly relationshipRepo: RelationshipRepository;
  readonly schedulerStateRepo: SchedulerStateRepository;

  private constructor(readonly db: Database) {
    this.memoryRepo = new DrizzleMemoryRepository(db);
    this.workspaceRepo = new DrizzleWorkspaceRepository(db);
    this.commentRepo = new DrizzleCommentRepository(db);
    this.sessionRepo = new DrizzleSessionTrackingRepository(db);
    this.sessionLifecycleRepo = new DrizzleSessionRepository(db);
    this.auditRepo = new DrizzleAuditRepository(db);
    this.flagRepo = new DrizzleFlagRepository(db);
    this.relationshipRepo = new DrizzleRelationshipRepository(db);
    this.schedulerStateRepo = new DrizzleSchedulerStateRepository(db);
  }

  static async create(databaseUrl: string): Promise<PostgresBackend> {
    const db = createDb(databaseUrl);
    await runMigrations(db);
    return new PostgresBackend(db);
  }

  async close(): Promise<void> {
    await this.db.$client.end();
  }

  async sessionStart(): Promise<BackendSessionStartMeta> {
    return {};
  }
}
