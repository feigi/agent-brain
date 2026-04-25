import "dotenv/config";
import { createDb, type Database } from "../src/db/index.js";
import { DrizzleMemoryRepository } from "../src/repositories/memory-repository.js";
import { DrizzleWorkspaceRepository } from "../src/repositories/workspace-repository.js";
import { DrizzleCommentRepository } from "../src/repositories/comment-repository.js";
import {
  DrizzleSessionTrackingRepository,
  DrizzleSessionRepository,
} from "../src/repositories/session-repository.js";
import { AuditService } from "../src/services/audit-service.js";
import { FlagService } from "../src/services/flag-service.js";
import { RelationshipService } from "../src/services/relationship-service.js";
import { DrizzleRelationshipRepository } from "../src/repositories/relationship-repository.js";
import { MockEmbeddingProvider } from "../src/providers/embedding/mock.js";
import { config } from "../src/config.js";
import { MemoryService } from "../src/services/memory-service.js";
import type { MemoryDetail, CreateSkipResult } from "../src/types/memory.js";
import type {
  StorageBackend,
  BackendSessionStartMeta,
} from "../src/backend/types.js";
import {
  memories,
  workspaces,
  comments,
  sessionTracking,
  sessions,
  auditLog,
  flags,
  relationships,
  schedulerState,
} from "../src/db/schema.js";
import { TEST_DB_URL } from "./global-setup.js";

let db: Database;

export function getTestDb(): Database {
  if (!db) {
    db = createDb(TEST_DB_URL);
  }
  return db;
}

/**
 * Minimal StorageBackend stub for unit/integration tests. Only implements
 * sessionStart() — all repo fields are intentionally omitted because tests
 * inject real repos directly. Override sessionStartMeta to control what
 * backend.sessionStart() returns.
 */
export class StubBackend {
  sessionStartMeta: BackendSessionStartMeta = {};

  async sessionStart(): Promise<BackendSessionStartMeta> {
    return this.sessionStartMeta;
  }

  async close(): Promise<void> {}
}

interface TestServiceOptions {
  auditService?: AuditService;
  flagService?: FlagService;
  withSessions?: boolean;
  maxFlagsPerSession?: number;
  relationshipService?: RelationshipService;
  backend?: StorageBackend;
}

/** Configurable factory — accepts any combination of optional services */
export function createTestServiceWith(
  options: TestServiceOptions = {},
): MemoryService {
  const testDb = getTestDb();
  const memoryRepo = new DrizzleMemoryRepository(testDb);
  const workspaceRepo = new DrizzleWorkspaceRepository(testDb);
  const embedder = new MockEmbeddingProvider(config.embeddingDimensions);
  const commentRepo = new DrizzleCommentRepository(testDb);
  const sessionRepo = new DrizzleSessionTrackingRepository(testDb);
  const sessionLifecycleRepo = options.withSessions
    ? new DrizzleSessionRepository(testDb)
    : undefined;

  return new MemoryService(
    memoryRepo,
    workspaceRepo,
    embedder,
    "test-project",
    commentRepo,
    sessionRepo,
    sessionLifecycleRepo,
    options.auditService,
    options.flagService,
    options.maxFlagsPerSession,
    options.relationshipService,
    options.backend,
  );
}

export function createTestService(): MemoryService {
  return createTestServiceWith();
}

/** Create a test service that includes the Phase 4 session lifecycle repository for budget tracking */
export function createTestServiceWithSessions(): MemoryService {
  return createTestServiceWith({ withSessions: true });
}

/** Create a test service that includes AuditService for audit logging */
export function createTestServiceWithAudit(
  auditService: AuditService,
): MemoryService {
  return createTestServiceWith({ auditService });
}

/** Create a test service that includes FlagService for session start flag delivery */
export function createTestServiceWithFlags(
  flagService: FlagService,
  auditService: AuditService,
  maxFlagsPerSession?: number,
): MemoryService {
  return createTestServiceWith({
    auditService,
    flagService,
    maxFlagsPerSession,
  });
}

/** Create a test service that includes RelationshipService for memory_get relationship enrichment */
export function createTestServiceWithRelationships(): {
  memoryService: MemoryService;
  relationshipService: RelationshipService;
} {
  const testDb = getTestDb();
  const relationshipRepo = new DrizzleRelationshipRepository(testDb);
  const memoryRepo = new DrizzleMemoryRepository(testDb);
  const relationshipService = new RelationshipService(
    relationshipRepo,
    memoryRepo,
    "test-project",
  );
  const memoryService = createTestServiceWith({ relationshipService });
  return { memoryService, relationshipService };
}

/** Truncate all tables between tests (D-64) */
export async function truncateAll(): Promise<void> {
  const testDb = getTestDb();
  await testDb.delete(relationships); // FK: references memories
  await testDb.delete(flags); // FK: references memories
  await testDb.delete(auditLog); // FK: references memories
  await testDb.delete(comments); // FK: references memories
  await testDb.delete(sessions); // FK: references workspaces (Phase 4)
  await testDb.delete(sessionTracking); // FK: references workspaces
  await testDb.delete(memories); // FK: references workspaces
  await testDb.delete(workspaces);
  await testDb.delete(schedulerState);
}

/** Assert that a create result is a MemoryDetail (not a skip). Use after service.create() in tests. */
export function assertMemory(
  result: MemoryDetail | CreateSkipResult,
): asserts result is MemoryDetail {
  if ("skipped" in result && result.skipped) {
    throw new Error(
      `Expected MemoryDetail but got CreateSkipResult: ${result.message}`,
    );
  }
}

/** Close DB connection after all tests */
export async function closeDb(): Promise<void> {
  if (db) {
    await db.$client.end();
    db = undefined!;
  }
}
