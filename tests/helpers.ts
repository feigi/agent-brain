import "dotenv/config";
import { createDb, type Database } from "../src/db/index.js";
import { DrizzleMemoryRepository } from "../src/repositories/memory-repository.js";
import { DrizzleProjectRepository } from "../src/repositories/project-repository.js";
import { DrizzleCommentRepository } from "../src/repositories/comment-repository.js";
import {
  DrizzleSessionTrackingRepository,
  DrizzleSessionRepository,
} from "../src/repositories/session-repository.js";
import { MockEmbeddingProvider } from "../src/providers/embedding/mock.js";
import { MemoryService } from "../src/services/memory-service.js";
import type { Memory, CreateSkipResult } from "../src/types/memory.js";
import {
  memories,
  projects,
  comments,
  sessionTracking,
  sessions,
} from "../src/db/schema.js";

let db: Database;

export function getTestDb(): Database {
  if (!db) {
    const url =
      process.env.DATABASE_URL ??
      "postgresql://agentic:agentic@localhost:5432/agent_brain";
    db = createDb(url);
  }
  return db;
}

export function createTestService(): MemoryService {
  const testDb = getTestDb();
  const memoryRepo = new DrizzleMemoryRepository(testDb);
  const projectRepo = new DrizzleProjectRepository(testDb);
  const embedder = new MockEmbeddingProvider();
  const commentRepo = new DrizzleCommentRepository(testDb);
  const sessionRepo = new DrizzleSessionTrackingRepository(testDb);
  return new MemoryService(
    memoryRepo,
    projectRepo,
    embedder,
    commentRepo,
    sessionRepo,
  );
}

/** Create a test service that includes the Phase 4 session lifecycle repository for budget tracking */
export function createTestServiceWithSessions(): MemoryService {
  const testDb = getTestDb();
  const memoryRepo = new DrizzleMemoryRepository(testDb);
  const projectRepo = new DrizzleProjectRepository(testDb);
  const embedder = new MockEmbeddingProvider();
  const commentRepo = new DrizzleCommentRepository(testDb);
  const sessionTrackingRepo = new DrizzleSessionTrackingRepository(testDb);
  const sessionLifecycleRepo = new DrizzleSessionRepository(testDb);
  return new MemoryService(
    memoryRepo,
    projectRepo,
    embedder,
    commentRepo,
    sessionTrackingRepo,
    sessionLifecycleRepo,
  );
}

/** Truncate all tables between tests (D-64) */
export async function truncateAll(): Promise<void> {
  const testDb = getTestDb();
  await testDb.delete(comments); // FK: references memories
  await testDb.delete(sessions); // FK: references projects (Phase 4)
  await testDb.delete(sessionTracking); // FK: references projects
  await testDb.delete(memories); // FK: references projects
  await testDb.delete(projects);
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
