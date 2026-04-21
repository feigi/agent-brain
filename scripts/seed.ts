import "dotenv/config";
import { createDb } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { DrizzleMemoryRepository } from "../src/repositories/memory-repository.js";
import { DrizzleWorkspaceRepository } from "../src/repositories/workspace-repository.js";
import { MockEmbeddingProvider } from "../src/providers/embedding/mock.js";
import { MemoryService } from "../src/services/memory-service.js";
import type { MemoryCreate } from "../src/types/memory.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://agentic:agentic@localhost:5432/agent_brain";

const PROJECT_ID = "agent-brain";

async function seed() {
  console.error("[seed] Connecting to database...");

  const db = createDb(DATABASE_URL);
  await runMigrations(db);

  const memoryRepo = new DrizzleMemoryRepository(db);
  const workspaceRepo = new DrizzleWorkspaceRepository(db);
  const embedder = new MockEmbeddingProvider();
  const service = new MemoryService(
    memoryRepo,
    workspaceRepo,
    embedder,
    PROJECT_ID,
  );

  let totalCreated = 0;
  const workspacesCreated = new Set<string>();

  async function createMemory(input: MemoryCreate): Promise<void> {
    const result = await service.create(input);
    if (input.workspace_id) workspacesCreated.add(input.workspace_id);
    totalCreated++;
    if ("skipped" in result.data) {
      console.error(`  [${totalCreated}] skipped: ${result.data.reason}`);
    } else {
      console.error(
        `  [${totalCreated}] ${result.data.id} - "${result.data.title}"`,
      );
    }
  }

  // --- Workspace 1: agent-brain (8 memories covering all types) ---
  console.error("\n[seed] Creating memories for workspace: agent-brain");

  await createMemory({
    workspace_id: "agent-brain",
    content:
      "PostgreSQL 17 with pgvector 0.8.x supports HNSW indexes for fast similarity search. Iterative index scans in 0.8.0 fix filtered search accuracy issues and provide up to 5.7x query performance improvement.",
    type: "fact",
    author: "alice",
    tags: ["postgres", "pgvector", "performance"],
    source: "manual",
  });

  await createMemory({
    workspace_id: "agent-brain",
    content:
      "Using 512 dimensions for embeddings -- retains 99% accuracy of 1024 at half the storage cost. Each vector takes 2KB. This is the best balance of accuracy, storage, and HNSW index build performance.",
    type: "decision",
    author: "alice",
    tags: ["embeddings", "performance", "storage"],
    source: "manual",
  });

  await createMemory({
    workspace_id: "agent-brain",
    content:
      "console.log in MCP stdio servers corrupts JSON-RPC framing because stdout is the transport channel. Always use console.error for debug output -- it writes to stderr and doesn't interfere with the protocol.",
    type: "learning",
    author: "bob",
    tags: ["mcp", "stdio", "debugging"],
    source: "agent-auto",
    session_id: "session-001",
  });

  await createMemory({
    workspace_id: "agent-brain",
    content:
      "All MCP tool responses use envelope format: { data, meta: { count, timing } }. The data field contains the actual response payload, meta.timing is milliseconds for the operation, and meta.count is present for list/search results.",
    type: "pattern",
    author: "alice",
    tags: ["mcp", "api-design", "envelope"],
    source: "manual",
  });

  await createMemory({
    workspace_id: "agent-brain",
    content:
      "Use nanoid for ID generation -- 21 chars, URL-safe, 148 bits of entropy. Faster and smaller than UUID. Import from nanoid package: import { nanoid } from 'nanoid'; const id = nanoid();",
    type: "preference",
    author: "alice",
    tags: ["ids", "nanoid"],
    source: "manual",
  });

  await createMemory({
    workspace_id: "agent-brain",
    content:
      "Layered architecture: transport (MCP stdio) -> tools (Zod schemas) -> services (business logic) -> repositories (data access) -> database (Drizzle + Postgres). Each layer only depends on the one below it. Tools never touch the database directly.",
    type: "architecture",
    author: "alice",
    tags: ["architecture", "layers", "separation-of-concerns"],
    source: "manual",
  });

  await createMemory({
    workspace_id: "agent-brain",
    content:
      "Optimistic locking via version column prevents concurrent update conflicts. Every update must include the expected version number. If it doesn't match, the update fails with ConflictError (409). The client must re-read and retry.",
    type: "decision",
    author: "bob",
    tags: ["concurrency", "optimistic-locking"],
    source: "manual",
  });

  await createMemory({
    workspace_id: "agent-brain",
    content:
      "Amazon Titan Text Embeddings V2 costs $0.02 per million tokens. Model ID: amazon.titan-embed-text-v2:0. Supports 8192 token input and configurable output dimensions (256/512/1024). Outputs unit-normalized vectors optimized for cosine similarity.",
    type: "fact",
    author: "alice",
    tags: ["embeddings", "aws", "titan", "pricing"],
    source: "manual",
  });

  // --- Workspace 2: side-project (2 memories) ---
  console.error("\n[seed] Creating memories for workspace: side-project");

  await createMemory({
    workspace_id: "side-project",
    content:
      "The side project uses React 19 with Server Components for the frontend. Data fetching happens server-side to reduce client bundle size and improve initial load performance.",
    type: "architecture",
    author: "bob",
    tags: ["react", "server-components", "frontend"],
    source: "manual",
  });

  await createMemory({
    workspace_id: "side-project",
    content:
      "Deploy the side project with Vercel -- automatic preview deployments on PRs, edge functions for API routes, and built-in analytics. The free tier covers our expected traffic.",
    type: "decision",
    author: "bob",
    tags: ["deploy", "vercel", "infrastructure"],
    source: "manual",
  });

  // --- User-scoped memory (visible across workspaces) ---
  console.error("\n[seed] Creating user-scoped memory for alice");

  await createMemory({
    workspace_id: "agent-brain",
    content:
      "Alice prefers TypeScript strict mode with noUncheckedIndexedAccess enabled. Always use explicit return types on exported functions. Favor composition over inheritance.",
    type: "preference",
    scope: "user",
    author: "alice",
    tags: ["typescript", "coding-style", "preferences"],
    source: "manual",
  });

  console.error(
    `\n[seed] Seeded ${totalCreated} memories across ${workspacesCreated.size} workspaces`,
  );

  await db.$client.end();
}

seed().catch((err) => {
  console.error("[seed] Fatal error:", err);
  process.exit(1);
});
