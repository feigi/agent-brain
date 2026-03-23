---
phase: 01-foundation-and-core-memory
plan: 01
subsystem: database, infra
tags: [typescript, drizzle, pgvector, postgres, docker, nanoid, mcp-sdk, vitest]

# Dependency graph
requires: []
provides:
  - "Drizzle schema with memories (19 columns) and projects tables"
  - "pgvector vector(512) column with HNSW index"
  - "Database client factory (createDb) and migration runner (runMigrations)"
  - "TypeScript types: Memory, MemoryCreate, MemoryUpdate, MemoryWithScore, Envelope"
  - "Utility modules: logger (stderr-only), id (nanoid), errors (domain error types)"
  - "Docker Compose with pgvector/pgvector:pg17 and auto-extension init"
  - "Project config, vitest setup, drizzle-kit config"
affects: [01-02, 01-03, 01-04]

# Tech tracking
tech-stack:
  added: [typescript@5.9, drizzle-orm@0.45, drizzle-kit@0.31, postgres.js@3.4, pgvector@0.2, vitest@4.1, "@modelcontextprotocol/sdk@1.27", "zod@4.3", nanoid@5, dotenv@16, tsx@4.21, "@aws-sdk/client-bedrock-runtime@3"]
  patterns: [stderr-only-logging, domain-error-hierarchy, nanoid-id-generation, docker-init-scripts-for-extensions, drizzle-pgvector-hnsw-index]

key-files:
  created: [package.json, tsconfig.json, docker-compose.yml, drizzle.config.ts, vitest.config.ts, src/config.ts, src/utils/logger.ts, src/utils/id.ts, src/utils/errors.ts, src/db/schema.ts, src/db/index.ts, src/db/migrate.ts, src/types/memory.ts, src/types/envelope.ts, tests/global-setup.ts, scripts/init-extensions.sql, "drizzle/0000_graceful_cerebro.sql"]
  modified: []

key-decisions:
  - "Used ef_construction (snake_case) in HNSW index .with() instead of efConstruction (camelCase) -- Drizzle passes keys as-is to SQL, pgvector expects snake_case"
  - "Added Docker init script (scripts/init-extensions.sql) mounted to /docker-entrypoint-initdb.d/ for pgvector extension setup, in addition to CREATE EXTENSION in migration SQL for production portability"

patterns-established:
  - "Stderr-only logging: all logger methods use console.error() to avoid corrupting MCP stdio transport"
  - "Domain error hierarchy: DomainError base class with code and statusHint, specialized subclasses for NotFound, Conflict, Validation, Embedding"
  - "Docker pgvector setup: pgvector/pgvector:pg17 image with init script for extension and healthcheck via pg_isready"
  - "Drizzle HNSW index: use snake_case parameter names in .with() (m, ef_construction) since Drizzle passes them verbatim to SQL"

requirements-completed: [INFR-04, INFR-05, CORE-06, CORE-07, CORE-08, CORE-09]

# Metrics
duration: 14min
completed: 2026-03-23
---

# Phase 01 Plan 01: Project Init and Schema Summary

**TypeScript project with Drizzle ORM schema (memories + projects), pgvector HNSW index on 512d vectors, Docker Compose with PG17, and all shared types/utilities**

## Performance

- **Duration:** 14 min
- **Started:** 2026-03-23T03:17:24Z
- **Completed:** 2026-03-23T03:32:13Z
- **Tasks:** 2
- **Files modified:** 22

## Accomplishments
- Complete project scaffolding with all runtime and dev dependencies installed
- Drizzle schema defining memories table (19 columns) with vector(512) column, HNSW index (m=16, ef_construction=64), and projects table with slug-based PK
- Generated and applied Drizzle migration against Docker Postgres with pgvector 0.8.2
- Shared TypeScript types (Memory, MemoryCreate, MemoryUpdate, MemoryWithScore, Envelope) and utility modules (logger, id, errors)

## Task Commits

Each task was committed atomically:

1. **Task 1: Initialize project with dependencies, configuration, and Docker** - `a6947d3` (feat)
2. **Task 2: Database schema, types, and migration infrastructure** - `7ba1a51` (feat)

## Files Created/Modified
- `package.json` - Project manifest with all runtime and dev dependencies
- `tsconfig.json` - TypeScript config with nodenext module resolution
- `docker-compose.yml` - pgvector/pgvector:pg17 with healthcheck and init script mount
- `drizzle.config.ts` - Drizzle Kit config pointing to schema and drizzle/ output
- `vitest.config.ts` - Vitest config with global setup for Docker + migrations
- `tests/global-setup.ts` - Vitest global setup: starts Docker, runs migrations
- `.env.example` - Documents all expected environment variables
- `.gitignore` - Ignores node_modules, dist, .env, tsbuildinfo
- `src/config.ts` - Typed config from environment variables with defaults
- `src/utils/logger.ts` - Stderr-only logger (MCP stdio safety)
- `src/utils/id.ts` - nanoid(21) wrapper for ID generation
- `src/utils/errors.ts` - Domain error hierarchy (DomainError, NotFoundError, ConflictError, ValidationError, EmbeddingError)
- `src/db/schema.ts` - Drizzle table definitions for memories and projects with pgvector + HNSW index
- `src/db/index.ts` - Database client factory (createDb) using postgres.js driver
- `src/db/migrate.ts` - Programmatic migration runner (runMigrations)
- `src/types/memory.ts` - Memory, MemoryCreate, MemoryUpdate, MemoryWithScore, MemoryType, MemoryScope types
- `src/types/envelope.ts` - Response envelope type with data and meta fields
- `scripts/init-extensions.sql` - Docker init script for pgvector extension
- `drizzle/0000_graceful_cerebro.sql` - Initial migration SQL with all tables, enums, indexes

## Decisions Made
- Used `ef_construction` (snake_case) instead of `efConstruction` (camelCase) in Drizzle HNSW index `.with()` -- Drizzle passes keys verbatim to SQL, pgvector expects snake_case
- Added Docker init script for pgvector extension in addition to `CREATE EXTENSION` in migration SQL -- belt-and-suspenders approach ensures extension is available regardless of migration order

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed HNSW index ef_construction parameter name**
- **Found during:** Task 2 (migration generation and application)
- **Issue:** Plan specified `.with({ m: 16, efConstruction: 64 })` but Drizzle ORM passes keys verbatim to SQL, and pgvector expects `ef_construction` (snake_case), not `efConstruction` (camelCase). Migration failed with "unrecognized parameter efconstruction".
- **Fix:** Changed to `.with({ m: 16, ef_construction: 64 })` in schema.ts
- **Files modified:** src/db/schema.ts
- **Verification:** Migration applies successfully, HNSW index created with correct parameters
- **Committed in:** 7ba1a51 (Task 2 commit)

**2. [Rule 3 - Blocking] Added Docker init script for pgvector extension**
- **Found during:** Task 2 (migration application)
- **Issue:** Editing the generated Drizzle migration to add `CREATE EXTENSION IF NOT EXISTS vector` was needed for the migration to work on a clean database without pgvector pre-enabled
- **Fix:** Added `scripts/init-extensions.sql` mounted via Docker Compose to `/docker-entrypoint-initdb.d/01-extensions.sql`, AND added `CREATE EXTENSION IF NOT EXISTS vector` to the migration SQL itself for production portability
- **Files modified:** docker-compose.yml, scripts/init-extensions.sql, drizzle/0000_graceful_cerebro.sql
- **Verification:** Clean DB restart with migration applies successfully
- **Committed in:** 7ba1a51 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes necessary for correct migration application. No scope creep.

## Issues Encountered
- `drizzle-kit migrate` CLI exit code 1 with no visible error message -- required programmatic migration via drizzle-orm to surface actual PostgreSQL error about unrecognized HNSW parameter name
- Drizzle ORM `.with()` passes JS object keys verbatim to SQL WITH clause -- camelCase keys don't work for pgvector parameters that expect snake_case

## User Setup Required
None - Docker Compose handles all local infrastructure.

## Known Stubs
None - all files are fully implemented with no placeholder data.

## Next Phase Readiness
- Database schema and types are ready for service layer (Plan 02: Embedding Provider)
- Docker Postgres with pgvector running and verified
- All shared utilities (logger, id, errors, config) available for import
- Migration infrastructure tested and working

## Self-Check: PASSED

All 17 key files verified present. Both task commits (a6947d3, 7ba1a51) verified in git history.

---
*Phase: 01-foundation-and-core-memory*
*Completed: 2026-03-23*
