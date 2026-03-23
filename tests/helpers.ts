import "dotenv/config";
import { createDb, type Database } from "../src/db/index.js";
import { DrizzleMemoryRepository } from "../src/repositories/memory-repository.js";
import { DrizzleProjectRepository } from "../src/repositories/project-repository.js";
import { MockEmbeddingProvider } from "../src/providers/embedding/mock.js";
import { MemoryService } from "../src/services/memory-service.js";
import { memories, projects, comments, sessionTracking } from "../src/db/schema.js";

let db: Database;

export function getTestDb(): Database {
  if (!db) {
    const url =
      process.env.DATABASE_URL ??
      "postgresql://agentic:agentic@localhost:5432/agentic_brain";
    db = createDb(url);
  }
  return db;
}

export function createTestService(): MemoryService {
  const testDb = getTestDb();
  const memoryRepo = new DrizzleMemoryRepository(testDb);
  const projectRepo = new DrizzleProjectRepository(testDb);
  const embedder = new MockEmbeddingProvider();
  return new MemoryService(memoryRepo, projectRepo, embedder);
}

/** Truncate all tables between tests (D-64) */
export async function truncateAll(): Promise<void> {
  const testDb = getTestDb();
  await testDb.delete(comments);         // FK: references memories
  await testDb.delete(sessionTracking);   // FK: references projects
  await testDb.delete(memories);          // FK: references projects
  await testDb.delete(projects);
}

/** Close DB connection after all tests */
export async function closeDb(): Promise<void> {
  if (db) {
    await db.$client.end();
    db = undefined!;
  }
}
