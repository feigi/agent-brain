---
phase: 01-foundation-and-core-memory
plan: 03
subsystem: mcp-tools, server
tags: [mcp-sdk, zod-schemas, stdio-transport, tool-registration, error-handling, graceful-shutdown]

# Dependency graph
requires:
  - phase: 01-foundation-and-core-memory
    provides: "MemoryService with all 8 operations, EmbeddingProvider, DrizzleMemoryRepository, DrizzleProjectRepository, database layer, types, utilities"
provides:
  - "8 registered MCP tools: memory_create, memory_get, memory_update, memory_archive, memory_search, memory_list, memory_verify, memory_list_stale"
  - "Tool utilities: toolResponse envelope wrapper, toolError for DomainError mapping, withErrorHandling catch-all"
  - "registerAllTools function wiring all tools to McpServer"
  - "MCP server entry point with stdio transport, auto-migration, graceful shutdown"
affects: [01-04, 02-01]

# Tech tracking
tech-stack:
  added: []
  patterns: [registerTool-pattern, tool-response-envelope, withErrorHandling-wrapper, cursor-string-parsing, user_id-to-author-mapping]

key-files:
  created: [src/tools/tool-utils.ts, src/tools/memory-create.ts, src/tools/memory-get.ts, src/tools/memory-update.ts, src/tools/memory-archive.ts, src/tools/memory-search.ts, src/tools/memory-list.ts, src/tools/memory-verify.ts, src/tools/memory-list-stale.ts, src/tools/index.ts, src/server.ts]
  modified: []

key-decisions:
  - "Tool parameter user_id maps to MemoryCreate.author field -- MCP tool schema uses user_id for agent ergonomics, service layer uses author for provenance"
  - "Cursor parsing done in tool layer (memory-list, memory-list-stale) converting pipe-delimited string to object before passing to service"
  - "z.record(z.string(), z.unknown()) required for zod v4 metadata field -- v4 requires explicit key type argument"

patterns-established:
  - "Tool registration: one file per tool exporting registerMemoryX(server, memoryService), all wired via registerAllTools"
  - "Tool response: all handlers wrapped with withErrorHandling catching DomainError -> isError:true, envelope via toolResponse"
  - "Tool descriptions include usage examples per D-15 for agent discoverability"
  - "Server entry: dotenv -> createDb -> runMigrations -> createEmbeddingProvider -> repos -> service -> McpServer -> registerAllTools -> StdioServerTransport -> connect"

requirements-completed: [INFR-01, CORE-01, CORE-02, CORE-03, CORE-04, CORE-05]

# Metrics
duration: 4min
completed: 2026-03-23
---

# Phase 01 Plan 03: MCP Tool Handlers and Server Entry Point Summary

**8 MCP tool handlers with Zod v4 schemas and usage examples, wired to MemoryService via registerAllTools, with stdio server entry point including auto-migration and graceful shutdown**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-23T03:41:46Z
- **Completed:** 2026-03-23T03:46:05Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- All 8 MCP tools registered with comprehensive Zod input schemas including field descriptions and usage examples in tool descriptions (D-15)
- Tool utilities providing consistent envelope responses (toolResponse) and DomainError-to-isError mapping (withErrorHandling)
- Server entry point wiring database, migrations, embedding provider, repositories, service, and tool registration with stdio transport
- Graceful shutdown handling SIGTERM/SIGINT with server.close() and postgres.js connection draining
- Zero console.log usage across entire src/ -- all logging via stderr logger

## Task Commits

Each task was committed atomically:

1. **Task 1: Tool utilities and all 8 MCP tool handlers** - `3b4c60d` (feat)
2. **Task 2: Tool registration index and MCP server entry point** - `3ff1a8b` (feat)

## Files Created/Modified
- `src/tools/tool-utils.ts` - Shared utilities: toolResponse, toolError, withErrorHandling
- `src/tools/memory-create.ts` - memory_create tool with full schema (project_id, content, type, scope, user_id, tags, source, session_id, metadata)
- `src/tools/memory-get.ts` - memory_get tool (id lookup)
- `src/tools/memory-update.ts` - memory_update tool with optimistic locking (version) and PATCH-style updates
- `src/tools/memory-archive.ts` - memory_archive tool accepting single ID or array (D-06)
- `src/tools/memory-search.ts` - memory_search tool with scope, limit, min_similarity parameters
- `src/tools/memory-list.ts` - memory_list tool with type/tag filters, cursor pagination, sort options
- `src/tools/memory-verify.ts` - memory_verify tool updating verified_at timestamp
- `src/tools/memory-list-stale.ts` - memory_list_stale tool with threshold_days and cursor pagination
- `src/tools/index.ts` - registerAllTools function importing and registering all 8 tools
- `src/server.ts` - MCP server entry point with stdio transport, auto-migration, graceful shutdown

## Decisions Made
- Tool parameter `user_id` maps to `MemoryCreate.author` -- keeps MCP tool schema ergonomic for agents while maintaining the service layer's `author` field for provenance tracking
- Cursor parsing (pipe-delimited string to `{ created_at, id }` object) handled in tool layer before passing to service, keeping service interface clean
- Used `z.record(z.string(), z.unknown())` for metadata field -- zod v4 requires explicit key type as first argument (breaking change from v3)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed z.record() call for zod v4 compatibility**
- **Found during:** Task 1 (Tool handlers)
- **Issue:** `z.record(z.unknown())` fails TypeScript compilation in zod v4 which requires 2 arguments (key type + value type)
- **Fix:** Changed to `z.record(z.string(), z.unknown())` in memory-create.ts and memory-update.ts
- **Files modified:** src/tools/memory-create.ts, src/tools/memory-update.ts
- **Verification:** `npx tsc --noEmit` passes
- **Committed in:** 3b4c60d (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minimal -- zod v4 API change required explicit key type. No scope creep.

## Issues Encountered
None beyond the zod v4 API change documented above.

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all files are fully implemented with no placeholder data.

## Next Phase Readiness
- MCP server is fully functional end-to-end: database -> migrations -> embedding -> service -> tools -> stdio transport
- Ready for Plan 04 (developer experience: seed script, npm scripts, MCP Inspector integration)
- Server can be started with `npx tsx src/server.ts` after Docker Postgres is running
- All 8 memory operations available to any MCP-compatible agent

## Self-Check: PASSED

All 11 key files verified present. Both task commits (3b4c60d, 3ff1a8b) verified in git history.

---
*Phase: 01-foundation-and-core-memory*
*Completed: 2026-03-23*
