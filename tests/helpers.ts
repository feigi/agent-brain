import "dotenv/config";
import { createDb, type Database } from "../src/db/index.js";
import { DrizzleMemoryRepository } from "../src/repositories/memory-repository.js";
import { DrizzleWorkspaceRepository } from "../src/repositories/workspace-repository.js";
import { DrizzleCommentRepository } from "../src/repositories/comment-repository.js";
import {
  DrizzleSessionTrackingRepository,
  DrizzleSessionRepository,
} from "../src/repositories/session-repository.js";
import { MockEmbeddingProvider } from "../src/providers/embedding/mock.js";
import { config } from "../src/config.js";
import { MemoryService } from "../src/services/memory-service.js";
import type { Memory, CreateSkipResult } from "../src/types/memory.js";
import {
  memories,
  workspaces,
  comments,
  sessionTracking,
  sessions,
} from "../src/db/schema.js";
import { TEST_DB_URL } from "./global-setup.js";

let db: Database;

export function getTestDb(): Database {
  if (!db) {
    db = createDb(TEST_DB_URL);
  }
  return db;
}

export function createTestService(): MemoryService {
  const testDb = getTestDb();
  const memoryRepo = new DrizzleMemoryRepository(testDb);
  const workspaceRepo = new DrizzleWorkspaceRepository(testDb);
  const embedder = new MockEmbeddingProvider(config.embeddingDimensions);
  const commentRepo = new DrizzleCommentRepository(testDb);
  const sessionRepo = new DrizzleSessionTrackingRepository(testDb);
  return new MemoryService(
    memoryRepo,
    workspaceRepo,
    embedder,
    "test-project",
    commentRepo,
    sessionRepo,
  );
}

/** Create a test service that includes the Phase 4 session lifecycle repository for budget tracking */
export function createTestServiceWithSessions(): MemoryService {
  const testDb = getTestDb();
  const memoryRepo = new DrizzleMemoryRepository(testDb);
  const workspaceRepo = new DrizzleWorkspaceRepository(testDb);
  const embedder = new MockEmbeddingProvider(config.embeddingDimensions);
  const commentRepo = new DrizzleCommentRepository(testDb);
  const sessionTrackingRepo = new DrizzleSessionTrackingRepository(testDb);
  const sessionLifecycleRepo = new DrizzleSessionRepository(testDb);
  return new MemoryService(
    memoryRepo,
    workspaceRepo,
    embedder,
    "test-project",
    commentRepo,
    sessionTrackingRepo,
    sessionLifecycleRepo,
  );
}

/** Truncate all tables between tests (D-64) */
export async function truncateAll(): Promise<void> {
  const testDb = getTestDb();
  await testDb.delete(comments); // FK: references memories
  await testDb.delete(sessions); // FK: references workspaces (Phase 4)
  await testDb.delete(sessionTracking); // FK: references workspaces
  await testDb.delete(memories); // FK: references workspaces
  await testDb.delete(workspaces);
}

/** Assert that a create result is a Memory (not a skip). Use after service.create() in tests. */
export function assertMemory(
  result: Memory | CreateSkipResult,
): asserts result is Memory {
  if ("skipped" in result && result.skipped) {
    throw new Error(
      `Expected Memory but got CreateSkipResult: ${result.message}`,
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
