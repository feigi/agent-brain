---
phase: 01-foundation-and-core-memory
verified: 2026-03-23T12:00:00Z
status: human_needed
score: 17/18 must-haves verified
human_verification:
  - test: "Confirm SCOP-04 RLS deferral is accepted"
    expected: "REQUIREMENTS.md says RLS but D-37/CONTEXT.md explicitly defers RLS to Phase 3. Application-level scoping is verified by tests. Human should confirm this known deviation is acceptable for Phase 1."
    why_human: "The requirement text says 'at the database level (RLS)' but the implementation uses application-level WHERE clauses. The decision to defer RLS was made by the user and documented in CONTEXT.md D-37. Tests verify the isolation behavior is correct. A human must confirm whether 'spirit of the requirement' (isolation achieved) satisfies SCOP-04 or whether RLS is truly required before phase sign-off."
---

# Phase 1: Foundation and Core Memory Verification Report

**Phase Goal:** Agents can configure the MCP server, save memories, search them by semantic similarity, and find them again across sessions
**Verified:** 2026-03-23
**Status:** human_needed — automated checks pass; one item requires human confirmation
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| #   | Truth                                                                                                                                                                                                  | Status               | Evidence                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Agent can connect to the MCP server and see all memory tools listed (save, get, update, archive, search)                                                                                               | VERIFIED             | `src/server.ts` uses `StdioServerTransport`, calls `registerAllTools(server, memoryService)`. `src/tools/index.ts` registers all 8 tools. All 8 tool files use `server.registerTool(...)` with Zod schemas.                                                                                                                                                                                |
| 2   | Agent can save a memory with content, title, and tags, then retrieve it by ID in a new session                                                                                                         | VERIFIED             | `memory-create.ts` → `memoryService.create()`. `memory-get.ts` → `memoryService.get()`. Integration test: "stores optional fields: source, session_id, metadata, tags" + "retrieves a memory by ID" pass. Memories persist in Postgres (CORE-07).                                                                                                                                          |
| 3   | Agent can search memories by natural language query and receive semantically relevant results with scores                                                                                              | VERIFIED             | `memory-search.ts` → `memoryService.search()` → embedding + `cosineDistance` query. `DrizzleMemoryRepository.search()` computes `1 - (cosineDistance)` for similarity. Returns `MemoryWithScore[]` with `similarity: number`. 5 search integration tests pass.                                                                                                                             |
| 4   | Memories are scoped to a project by default; a user-scoped memory is accessible across projects                                                                                                        | VERIFIED (app-level) | `DrizzleMemoryRepository.search()` and `.list()` apply `WHERE project_id = ?` for project scope and `WHERE author = ? AND scope = 'user'` for user scope. Tests "project-scoped memory not visible in other project" and "user-scoped memory visible across projects" both pass. NOTE: SCOP-04 requirement specifies RLS; implementation uses app-level filtering. See human verification. |
| 5   | Switching embedding providers requires only implementing the provider interface and changing configuration — no data migration needed because raw text and model metadata are stored alongside vectors | VERIFIED             | `EmbeddingProvider` interface in `src/providers/embedding/types.ts`. `createEmbeddingProvider()` factory switches on `config.embeddingProvider`. Schema stores `content` (raw text, CORE-08), `embedding_model`, `embedding_dimensions` (CORE-09). No data migration needed — re-embed from stored raw text.                                                                               |

**Score: 5/5 truths verified** (4/5 fully automated; 1 with human confirmation pending on RLS wording)

---

### Required Artifacts

| Artifact                                   | Expected                                                                                       | Status   | Details                                                                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                             | Project manifest with @modelcontextprotocol/sdk                                                | VERIFIED | name: "agentic-brain", type: "module", all 9 required deps present                                                                                                                                           |
| `src/db/schema.ts`                         | Drizzle table definitions; exports memories, projects, memoryTypeEnum, memoryScopeEnum         | VERIFIED | All 4 exports present. `vector("embedding", { dimensions: 512 })`. HNSW index with `m: 16, ef_construction: 64`. 19 columns on memories table.                                                               |
| `src/db/index.ts`                          | Database client factory; exports createDb                                                      | VERIFIED | Exports `createDb` and `Database` type. Imports `* as schema`. Has `onnotice: () => {}` for NOTICE suppression.                                                                                              |
| `src/db/migrate.ts`                        | Auto-migration runner; exports runMigrations                                                   | VERIFIED | Exports `runMigrations(db)`, calls `migrate(db, { migrationsFolder: "./drizzle" })`.                                                                                                                         |
| `src/types/memory.ts`                      | TypeScript types: Memory, MemoryCreate, MemoryUpdate, MemoryWithScore, MemoryType, MemoryScope | VERIFIED | All 6 types exported. Memory excludes embedding vector (D-44). MemoryWithScore extends Memory with `similarity: number`.                                                                                     |
| `src/types/envelope.ts`                    | Envelope<T> interface                                                                          | VERIFIED | Exports `Envelope<T>` with `data: T` and `meta: { count?, timing?, cursor?, has_more? }`.                                                                                                                    |
| `src/providers/embedding/types.ts`         | EmbeddingProvider interface                                                                    | VERIFIED | Exports `EmbeddingProvider` with `embed(text): Promise<number[]>`, `modelName`, `dimensions`.                                                                                                                |
| `src/providers/embedding/titan.ts`         | TitanEmbeddingProvider                                                                         | VERIFIED | Implements EmbeddingProvider. Model `amazon.titan-embed-text-v2:0`, dimensions 512. Truncates at 32000 chars. Sends `{ inputText, dimensions: 512, normalize: true }`. Wraps errors in EmbeddingError.       |
| `src/providers/embedding/mock.ts`          | MockEmbeddingProvider                                                                          | VERIFIED | Returns 512-dim deterministic vector using hash. Spot-check confirmed: `dims: 512, deterministic: true`.                                                                                                     |
| `src/providers/embedding/index.ts`         | createEmbeddingProvider factory                                                                | VERIFIED | Switches on `config.embeddingProvider` (titan/mock). Re-exports all provider types.                                                                                                                          |
| `src/repositories/types.ts`                | MemoryRepository and ProjectRepository interfaces                                              | VERIFIED | Exports both interfaces, plus ListOptions, SearchOptions, StaleOptions. MemoryRepository has all 8 methods.                                                                                                  |
| `src/repositories/memory-repository.ts`    | DrizzleMemoryRepository                                                                        | VERIFIED | Implements all 8 methods. Uses `cosineDistance` with `1 - (distance)` for similarity. Never selects embedding column (D-44). Archive nulls embedding (D-28). Optimistic locking throws ConflictError (D-30). |
| `src/repositories/project-repository.ts`   | DrizzleProjectRepository                                                                       | VERIFIED | `findOrCreate` uses INSERT ON CONFLICT DO NOTHING with race condition handling.                                                                                                                              |
| `src/services/memory-service.ts`           | MemoryService with all 8 operations                                                            | VERIFIED | All methods: create, get, update, archive, search, list, verify, listStale. Auto-title (D-03), re-embed on update (D-27), fail entirely on embedding error (D-54), all return `Envelope<T>` with timing.     |
| `src/tools/memory-create.ts`               | memory_create MCP tool                                                                         | VERIFIED | Registers "memory_create" with Zod schema. 10 input fields including optional title, tags, scope. Calls `memoryService.create()`. Uses `withErrorHandling`.                                                  |
| `src/tools/memory-search.ts`               | memory_search MCP tool                                                                         | VERIFIED | Registers "memory_search". Calls `memoryService.search()`. Default limit 10, min_similarity 0.3.                                                                                                             |
| `src/tools/index.ts`                       | registerAllTools — all 8 tools                                                                 | VERIFIED | Imports and calls all 8 register functions. Exports `registerAllTools(server, memoryService)`. Spot-check confirmed: `typeof registerAllTools === 'function'`.                                               |
| `src/server.ts`                            | MCP server entry point with stdio transport                                                    | VERIFIED | Uses `StdioServerTransport`, `McpServer("agentic-brain")`, calls `runMigrations`, `createEmbeddingProvider`, `registerAllTools`. SIGTERM/SIGINT handled. `db.$client.end()` in shutdown.                     |
| `tests/helpers.ts`                         | Test utilities: createTestService, truncateAll, closeDb                                        | VERIFIED | All 4 exports: `createTestService`, `truncateAll`, `closeDb`, `getTestDb`. Uses `MockEmbeddingProvider`. FK-safe delete order (memories before projects).                                                    |
| `tests/integration/memory-crud.test.ts`    | CRUD integration tests                                                                         | VERIFIED | 15 test cases. Covers create, get, update, archive (single+bulk+idempotent), verify, list (sort+filter+pagination). All use `beforeEach(truncateAll)`.                                                       |
| `tests/integration/memory-search.test.ts`  | Search integration tests                                                                       | VERIFIED | 5 test cases: similarity ranking, limit, archived exclusion, min_similarity threshold, score range validation.                                                                                               |
| `tests/integration/memory-scoping.test.ts` | Scoping integration tests                                                                      | VERIFIED | 5 test cases: project isolation, user cross-project, auto-create project, stale detection, recently-verified exclusion from stale.                                                                           |
| `scripts/seed.ts`                          | Development seed script                                                                        | VERIFIED | Creates 11 memories across 2 projects covering all 6 types plus 1 user-scoped memory. Logs to stderr. Calls `db.$client.end()`.                                                                              |
| `drizzle/0000_graceful_cerebro.sql`        | Initial migration SQL                                                                          | VERIFIED | Contains `CREATE EXTENSION IF NOT EXISTS vector`, `CREATE TYPE memory_type AS ENUM(...)`, `CREATE TYPE memory_scope AS ENUM(...)`, `CREATE TABLE memories`, HNSW index.                                      |

---

### Key Link Verification

| From                                    | To                                 | Via                              | Status | Details                                                                                    |
| --------------------------------------- | ---------------------------------- | -------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `src/db/index.ts`                       | `src/db/schema.ts`                 | `import * as schema`             | WIRED  | Line 3: `import * as schema from "./schema.js"`                                            |
| `src/db/migrate.ts`                     | `drizzle/`                         | `migrationsFolder: "./drizzle"`  | WIRED  | `migrate(db, { migrationsFolder: "./drizzle" })`                                           |
| `src/db/schema.ts`                      | `drizzle-orm/pg-core`              | `vector(512)`                    | WIRED  | Line 1 imports vector, line 34: `vector("embedding", { dimensions: 512 })`                 |
| `src/services/memory-service.ts`        | `src/providers/embedding/types.ts` | constructor injection            | WIRED  | Constructor parameter `embeddingProvider: EmbeddingProvider`, used in create/update/search |
| `src/services/memory-service.ts`        | `src/repositories/types.ts`        | constructor injection            | WIRED  | Constructor parameters `memoryRepo: MemoryRepository`, `projectRepo: ProjectRepository`    |
| `src/repositories/memory-repository.ts` | `src/db/schema.ts`                 | Drizzle query builder            | WIRED  | Line 7: `import { memories } from "../db/schema.js"`                                       |
| `src/tools/memory-create.ts`            | `src/services/memory-service.ts`   | `memoryService.create()`         | WIRED  | Line 29: `await memoryService.create({...})`                                               |
| `src/tools/index.ts`                    | `src/tools/memory-*.ts`            | imports and calls all 8          | WIRED  | All 8 register functions imported and called in registerAllTools                           |
| `src/server.ts`                         | `src/tools/index.ts`               | `registerAllTools(server, ...)`  | WIRED  | Line 11: `import { registerAllTools }`, line 40: `registerAllTools(server, memoryService)` |
| `src/server.ts`                         | `src/db/migrate.ts`                | `runMigrations(db)`              | WIRED  | Line 6: import, line 21: `await runMigrations(db)`                                         |
| `tests/helpers.ts`                      | `src/services/memory-service.ts`   | `new MemoryService(...)`         | WIRED  | Creates full service stack with real DB + MockEmbeddingProvider                            |
| `tests/integration/memory-crud.test.ts` | `tests/helpers.ts`                 | `createTestService, truncateAll` | WIRED  | Lines 2-3: import, used in beforeEach and test bodies                                      |

---

### Data-Flow Trace (Level 4)

| Artifact                     | Data Variable   | Source                                                                                                   | Produces Real Data                                                                          | Status  |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------- |
| `src/tools/memory-search.ts` | `result`        | `memoryService.search()` → `memoryRepo.search()` → Drizzle cosineDistance query → DB                     | Yes — Drizzle `cosineDistance` query against real pgvector table, filtered by project/scope | FLOWING |
| `src/tools/memory-create.ts` | `result`        | `memoryService.create()` → `embeddingProvider.embed()` + `memoryRepo.create()` → DB INSERT               | Yes — real DB insert with generated embedding                                               | FLOWING |
| `src/tools/memory-list.ts`   | `result`        | `memoryService.list()` → `memoryRepo.list()` → Drizzle SELECT with WHERE/ORDER/LIMIT                     | Yes — cursor-paginated DB query                                                             | FLOWING |
| `src/server.ts`              | `memoryService` | Constructed from real `DrizzleMemoryRepository`, `DrizzleProjectRepository`, `createEmbeddingProvider()` | Yes — all dependencies are real implementations                                             | FLOWING |

---

### Behavioral Spot-Checks

| Behavior                                     | Command                                                      | Result                                            | Status |
| -------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- | ------ |
| MockEmbeddingProvider returns 512-dim vector | `npx tsx test-spot.ts` (MockEmbeddingProvider.embed('test')) | `dims: 512`                                       | PASS   |
| MockEmbeddingProvider is deterministic       | Same command                                                 | `deterministic: true`                             | PASS   |
| MemoryService is a constructor function      | `typeof MemoryService` via tsx                               | `"function"`                                      | PASS   |
| registerAllTools is a function               | `typeof registerAllTools` via tsx                            | `"function"`                                      | PASS   |
| No console.log in src/                       | `grep -rn "console\.log" src/`                               | No matches                                        | PASS   |
| Migration SQL has CREATE EXTENSION           | `head drizzle/0000_graceful_cerebro.sql`                     | `CREATE EXTENSION IF NOT EXISTS vector` at line 1 | PASS   |

---

### Requirements Coverage

| Requirement | Source Plan  | Description                                                                                         | Status             | Evidence                                                                                                                                                                             |
| ----------- | ------------ | --------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| INFR-01     | 01-03        | MCP server exposes all memory operations as tools via stdio transport                               | SATISFIED          | `StdioServerTransport` in server.ts, all 8 tools registered                                                                                                                          |
| INFR-02     | 01-02        | Storage layer abstracted behind interface                                                           | SATISFIED          | `MemoryRepository` interface in repositories/types.ts, `DrizzleMemoryRepository` implements it                                                                                       |
| INFR-03     | 01-02        | Embedding provider abstracted behind interface                                                      | SATISFIED          | `EmbeddingProvider` interface with Titan and Mock implementations, factory function                                                                                                  |
| INFR-04     | 01-01        | Database schema supports pgvector with HNSW indexing                                                | SATISFIED          | `vector(512)` column, HNSW index m=16/ef_construction=64 in schema.ts and migration SQL                                                                                              |
| INFR-05     | 01-01        | Database migrations managed programmatically (Drizzle ORM)                                          | SATISFIED          | `runMigrations()` using drizzle-orm/postgres-js/migrator, called on server startup                                                                                                   |
| CORE-01     | 01-03, 01-04 | User can save a memory with content, optional title, and optional tags via MCP tool                 | SATISFIED          | `memory_create` tool with title? and tags? optional fields, integration test confirms                                                                                                |
| CORE-02     | 01-03, 01-04 | User can retrieve a specific memory by ID                                                           | SATISFIED          | `memory_get` tool delegates to `memoryService.get(id)`, integration test passes                                                                                                      |
| CORE-03     | 01-03, 01-04 | User can update an existing memory's content, title, or tags                                        | SATISFIED          | `memory_update` tool with PATCH-style partial updates, re-embeds on content/title change                                                                                             |
| CORE-04     | 01-03, 01-04 | User can archive a memory (soft delete, excluded from search)                                       | SATISFIED          | `memory_archive` tool, `archived_at` timestamp, archive sets embedding to null, excluded from all queries                                                                            |
| CORE-05     | 01-03, 01-04 | User can search memories by semantic similarity with ranked results and scores                      | SATISFIED          | `memory_search` tool, cosineDistance search, returns MemoryWithScore[] with `similarity` field                                                                                       |
| CORE-06     | 01-01        | User can tag memories with categories (fact, decision, learning, pattern, preference, architecture) | SATISFIED          | `memory_type` PostgreSQL enum enforces exactly these 6 values; Zod enum in tool schema                                                                                               |
| CORE-07     | 01-04        | Memories persist across agent sessions in Postgres                                                  | SATISFIED          | Stored in Postgres via Drizzle, persists beyond server restart, integration tests confirm                                                                                            |
| CORE-08     | 01-01        | Raw text stored alongside embeddings                                                                | SATISFIED          | `content text NOT NULL` column in schema always populated, never overwritten                                                                                                         |
| CORE-09     | 01-01        | Embedding model metadata stored with each memory                                                    | SATISFIED          | `embedding_model` and `embedding_dimensions` columns; set on create and re-embed                                                                                                     |
| SCOP-01     | 01-02, 01-04 | Memories scoped to a project — agents only see memories for their current project                   | SATISFIED          | `WHERE project_id = ?` in search and list queries when scope = "project"                                                                                                             |
| SCOP-02     | 01-02, 01-04 | User-level memories follow the user across all projects                                             | SATISFIED          | `WHERE author = ? AND scope = 'user'` query, integration test "user-scoped memory visible across projects" passes                                                                    |
| SCOP-04     | 01-02, 01-04 | Cross-project memory leakage prevented at the database level (RLS)                                  | PARTIAL — see note | App-level WHERE clause prevents leakage; RLS (`isRLSEnabled: false`) deliberately deferred per D-37 and user decision. Behavior is correct, mechanism differs from requirement text. |

**Requirement coverage note on SCOP-04:** The REQUIREMENTS.md text says "(RLS)" but `CONTEXT.md` decision D-37 explicitly states "App-level filtering for project scoping in Phase 1 (WHERE clauses). RLS deferred." The `<specifics>` section confirms: "User chose app-level filtering over RLS for Phase 1 — simpler to implement, RLS can come with team features." CONTEXT.md `<deferred>` section lists "RLS enforcement → Phase 3." The isolation behavior (no cross-project leakage) is verified by the scoping integration test. This requires human confirmation.

---

### Anti-Patterns Found

| File       | Pattern | Severity | Impact |
| ---------- | ------- | -------- | ------ |
| None found | —       | —        | —      |

Scanned all `src/` TypeScript files. No TODO/FIXME/PLACEHOLDER comments. No `console.log` (all logging uses `console.error` via logger). No empty return stubs. No hardcoded empty arrays/objects that feed into rendering or results.

---

### Human Verification Required

#### 1. SCOP-04 RLS Deferral Acceptance

**Test:** Review the SCOP-04 requirement against the implementation decision and decide if Phase 1 sign-off is acceptable.

**Background:**

- REQUIREMENTS.md says: `SCOP-04: Cross-project memory leakage is prevented at the database level (RLS)`
- CONTEXT.md D-37 says: "App-level filtering for project scoping in Phase 1 (WHERE clauses). RLS deferred."
- CONTEXT.md `<specifics>` confirms: "User chose app-level filtering over RLS for Phase 1 — simpler to implement, RLS can come with team features"
- CONTEXT.md `<deferred>` says: "RLS enforcement → Phase 3"
- The Drizzle migration snapshot shows `isRLSEnabled: false` for both tables
- The integration test "project-scoped memory not visible in other project (SCOP-01, SCOP-04)" passes — isolation behavior is correct

**Expected:** Human confirms either: (a) app-level filtering satisfies SCOP-04 for Phase 1, or (b) RLS must be implemented before phase sign-off.

**Why human:** The requirement text and implementation intention (D-37) conflict. The behavior is correct but the mechanism differs from what REQUIREMENTS.md specifies. The team documented this tradeoff explicitly — only a human can decide whether that tradeoff is acceptable for Phase 1 completion.

---

## Gaps Summary

No blocking gaps found. All 17 explicit must-have artifacts from plans 01-04 are present, substantive, and wired. All 5 ROADMAP.md success criteria are functionally met. The single human verification item (SCOP-04 RLS deferral) is a known, documented design decision that requires human sign-off — not a gap introduced by incomplete implementation.

The SCOP-04 situation is unusual: the requirements document says "RLS" but the decision log (which postdates requirements) deliberately chose app-level filtering. The functionality is correct. The question is whether the requirement text or the decision log takes precedence.

---

_Verified: 2026-03-23_
_Verifier: Claude (gsd-verifier)_
