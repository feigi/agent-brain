# Stdio to Streamable HTTP Transport Migration

**Date:** 2026-03-24
**Status:** Draft
**Scope:** Replace the stdio MCP transport with Streamable HTTP, containerize the server, and simplify hooks.

## Problem

The agent-brain MCP server uses `StdioServerTransport`. Claude Code manages the server process lifecycle, and hooks must spawn a new server process for each invocation — incurring cold-start overhead (tsx compilation, DB connection, migrations check, embedding provider init) and requiring complex bash scripts that speak JSON-RPC over stdio pipes.

### Pain Points

1. **Latency:** Every hook invocation pays full startup cost (~2-3s) to make a single tool call.
2. **Complexity:** The session-start hook is 52 lines of bash that constructs JSON-RPC messages, pipes them through stdio, and parses responses — fragile and hard to debug.
3. **Single-client:** Only one process can connect to a stdio server at a time. Hooks and Claude Code cannot share a running instance.

## Solution

Run agent-brain as a persistent HTTP server in Docker alongside Postgres and Ollama. Claude Code connects as a Streamable HTTP MCP client. Hooks call a lightweight REST API on the same server.

## Design

### 1. Server Transport Change

**File:** `src/server.ts`

Replace `StdioServerTransport` with `StreamableHTTPServerTransport` from the MCP SDK, served behind Express via `createMcpExpressApp()`.

Key decisions:

- **Stateful mode:** Each Claude Code session gets its own MCP session ID via `sessionIdGenerator: () => randomUUID()`.
- **Shared application state:** The MCP server instance, database connection, embedding provider, and `MemoryService` are created once at startup. Only the transport is per-session.
- **Express routes:** POST/GET/DELETE on `/mcp` per the Streamable HTTP spec. The SDK's `StreamableHTTPServerTransport.handleRequest()` handles all protocol details.
- **Port:** `19898`, configurable via `PORT` env var.
- **Bind address:** `0.0.0.0` inside Docker (mapped to `localhost:19898` on host). DNS rebinding protection enabled by default via `createMcpExpressApp()`.
- **Logging:** Remains on `console.error()` via the existing logger.
- **Graceful shutdown:** SIGTERM/SIGINT close all active transports, then the DB connection.

**New dependency:** `express` (required by `createMcpExpressApp` from the SDK).

### 2. REST API for Hooks

Alongside the MCP endpoint, add lightweight REST routes that call `MemoryService` directly — no MCP protocol handshake required.

**Routes:**

| Method | Path                   | Purpose                                                                                                            |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/health`              | Returns `200 OK` if server is running. Used by Docker healthcheck and hooks.                                       |
| POST   | `/api/tools/:toolName` | Invokes a tool by name. Body is the tool's input arguments as JSON. Returns the tool's response envelope directly. |

The `/api/tools/:toolName` route maps tool names to service methods. This avoids hooks needing to perform the MCP initialize → tool call handshake. A hook call becomes:

```bash
curl -s -X POST http://localhost:19898/api/tools/memory_session_start \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"...","user_id":"...","limit":10}'
```

**Security:** Localhost-only binding. No authentication for now (can add bearer token later).

**Scope:** Only the tools that hooks actually call need REST routes initially (`memory_session_start`). Others can be added as needed. The MCP endpoint remains the primary interface for Claude Code.

### 3. Dockerfile

New `Dockerfile` in project root:

- **Base:** `node:22-slim`
- **Multi-stage build:**
  - Stage 1 (deps): copy `package.json` + `package-lock.json`, `npm ci --omit=dev` + `tsx` as a runtime dep
  - Stage 2 (app): copy `src/`, `drizzle/`, `scripts/`, `tsconfig.json`
- **Entry point:** `npx tsx src/server.ts`
- **No build step:** `tsx` runs TypeScript directly, matching the existing dev workflow.
- **Expose:** `19898`

### 4. Docker Compose — Two Configurations

Two compose files for two workflows:

**`docker-compose.yml` (dev infrastructure only — default):**

Postgres + Ollama only. The server runs on the host via `npm run dev`. This is the existing behavior, unchanged.

```yaml
# Unchanged — postgres and ollama services only
```

**`docker-compose.prod.yml` (full stack):**

Extends the base with the agentic-brain server container. Used when you want everything containerized (e.g., testing the Docker build, or running as a persistent daemon).

```yaml
# docker-compose.prod.yml
services:
  agentic-brain:
    build: .
    ports:
      - "19898:19898"
    environment:
      DATABASE_URL: postgres://agentic:agentic@postgres:5432/agentic_brain
      EMBEDDING_PROVIDER: ollama
      OLLAMA_BASE_URL: http://ollama:11434
      EMBEDDING_DIMENSIONS: 768
      PORT: 19898
    depends_on:
      postgres:
        condition: service_healthy
      ollama:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:19898/health"]
      interval: 5s
      timeout: 5s
      retries: 5
```

**Usage:**

- Dev: `docker compose up` (just infra, run server with `npm run dev`)
- Full: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up`

The `npm run dev` script is updated to also start the HTTP server (not stdio), so the dev experience is: infra in Docker, server on host with hot-reload via `tsx watch`.

### 5. Hook Simplification

**`hooks/memory-session-start.sh` — rewritten:**

```bash
#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
USER_ID=$(whoami)
WORKSPACE_ID=$(basename "$CWD")

# Check server health
if ! curl -sf http://localhost:19898/health >/dev/null 2>&1; then
  exit 0  # Server down — fail gracefully
fi

RESPONSE=$(curl -s -X POST http://localhost:19898/api/tools/memory_session_start \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_id\":\"${WORKSPACE_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}")

if [ -z "$RESPONSE" ]; then
  exit 0
fi

MEMORIES_ESCAPED=$(echo "$RESPONSE" | jq -Rs '.')
cat <<EOF
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ${MEMORIES_ESCAPED}}}
EOF
```

From 52 lines of JSON-RPC plumbing to ~15 lines with a single `curl`.

**`hooks/memory-session-review.sh` — unchanged.** No MCP calls today; it reads the transcript and returns block/allow.

**`hooks/memory-guard.sh` — unchanged.** Pure file path check, no MCP calls.

**Fallback:** All hooks that call the server check `/health` first. If the server is down, they exit 0 (no-op) rather than blocking the Claude Code session.

### 6. Claude Code MCP Client Configuration

**Current** (stdio, in `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "agentic-brain": {
      "command": "npx",
      "args": ["tsx", "/Users/chris/dev/agent-brain/src/server.ts"]
    }
  }
}
```

**New** (Streamable HTTP):

```json
{
  "mcpServers": {
    "agentic-brain": {
      "url": "http://localhost:19898/mcp"
    }
  }
}
```

Claude Code natively supports Streamable HTTP MCP servers via the `url` field. No command, no args, no process management.

The `hooks/settings-snippet.json` in the repo is updated to reflect this.

### 7. Removals

| Item                                         | Reason                                             |
| -------------------------------------------- | -------------------------------------------------- |
| `StdioServerTransport` import in `server.ts` | Replaced by `StreamableHTTPServerTransport`        |
| `bin/agentic-brain.mjs`                      | No longer needed — server isn't spawned by clients |
| `"bin"` field in `package.json`              | Same                                               |
| `npm run inspect` script (current form)      | Update to point MCP Inspector at the HTTP URL      |

### 8. What Stays Unchanged

- All 11 tool definitions (`src/tools/`)
- `MemoryService` and all business logic (`src/services/`)
- All repositories (`src/repositories/`)
- Database schema and migrations (`src/db/`, `drizzle/`)
- Embedding provider abstraction (`src/providers/embedding/`)
- Prompts (`src/prompts/`)
- Stop hook and guard hook
- `npm start` / `npm run dev` — still useful for running the server on the host (now starts HTTP server instead of stdio)

## Migration Steps

1. Add `express` dependency
2. Rewrite `src/server.ts` for Streamable HTTP transport
3. Add REST routes (`/health`, `/api/tools/:toolName`)
4. Update `npm run dev` to start the HTTP server (with `tsx watch`)
5. Create `Dockerfile`
6. Create `docker-compose.prod.yml` with `agentic-brain` service (base `docker-compose.yml` unchanged)
7. Rewrite `hooks/memory-session-start.sh` to use `curl`
8. Update `hooks/settings-snippet.json` with new MCP config
9. Remove `bin/agentic-brain.mjs` and `"bin"` from `package.json`
10. Update `npm run inspect` script
11. Update `~/.claude/settings.json` on the dev machine
12. Test: `docker compose up`, verify Claude Code connects, verify hooks work

## Future Work

- **Bearer token auth:** Add `Authorization: Bearer <token>` header validation for non-localhost deployments.
- **Team server deployment:** Same HTTP server, deployed to a shared host with proper auth.
- **Resumability:** The SDK's `EventStore` enables SSE stream resumption. Not needed for local use but valuable for team deployments over unreliable connections.
