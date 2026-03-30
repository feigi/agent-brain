# Stdio to Streamable HTTP Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stdio MCP transport with Streamable HTTP so the server runs as a persistent process, Claude Code connects via URL, and hooks use simple curl calls.

**Architecture:** Rewrite `src/server.ts` to use `StreamableHTTPServerTransport` behind Express. Add a thin REST layer (`/health`, `/api/tools/:toolName`) for hook access. Containerize the server via Dockerfile + `docker-compose.prod.yml`. Simplify hooks from JSON-RPC-over-stdio to single curl calls.

**Tech Stack:** Express (via `createMcpExpressApp` from MCP SDK), `StreamableHTTPServerTransport` (MCP SDK), Docker, existing Drizzle/postgres.js/pgvector stack unchanged.

**Spec:** `docs/superpowers/specs/2026-03-24-stdio-to-streamable-http-design.md`

---

## File Map

| Action | File                            | Responsibility                                                                         |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------- |
| Modify | `src/server.ts`                 | Replace stdio transport with Express + StreamableHTTPServerTransport. Add REST routes. |
| Modify | `src/config.ts`                 | Add `port` config field                                                                |
| Modify | `package.json`                  | Add `express` dep, add `@types/express` devDep, remove `"bin"` field, update scripts   |
| Create | `Dockerfile`                    | Multi-stage build for containerized server                                             |
| Create | `docker-compose.prod.yml`       | Adds agentic-brain service alongside existing infra                                    |
| Modify | `hooks/memory-session-start.sh` | Rewrite: curl-based instead of stdio pipeline                                          |
| Modify | `hooks/settings-snippet.json`   | Update MCP server config from command/args to url                                      |
| Delete | `bin/agentic-brain.mjs`         | No longer needed — server isn't spawned by clients                                     |
| Create | `src/routes/health.ts`          | GET /health endpoint                                                                   |
| Create | `src/routes/api-tools.ts`       | POST /api/tools/:toolName endpoint                                                     |
| Create | `src/routes/index.ts`           | Express route registration                                                             |

---

### Task 1: Add Express Dependency and Port Config

**Files:**

- Modify: `package.json`
- Modify: `src/config.ts`

- [ ] **Step 1: Install express and its types**

Run:

```bash
npm install express && npm install -D @types/express
```

- [ ] **Step 2: Add `port` to config**

In `src/config.ts`, add after the `duplicateThreshold` line:

```typescript
port: Number(process.env.PORT ?? "19898"),
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json src/config.ts
git commit -m "feat: add express dependency and port config"
```

---

### Task 2: Create REST Route Handlers

**Files:**

- Create: `src/routes/health.ts`
- Create: `src/routes/api-tools.ts`
- Create: `src/routes/index.ts`

- [ ] **Step 1: Create `src/routes/health.ts`**

```typescript
import { Router } from "express";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

export { router as healthRouter };
```

- [ ] **Step 2: Create `src/routes/api-tools.ts`**

This maps tool names to `MemoryService` methods. Initially only `memory_session_start` is wired up, but the pattern is extensible.

```typescript
import { Router } from "express";
import type { MemoryService } from "../services/memory-service.js";

export function createApiToolsRouter(memoryService: MemoryService): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (req.is("json")) {
      next();
    } else {
      res.status(415).json({ error: "Content-Type must be application/json" });
    }
  });

  router.post("/api/tools/:toolName", async (req, res) => {
    const { toolName } = req.params;

    try {
      switch (toolName) {
        case "memory_session_start": {
          const { workspace_id, user_id, context, limit } = req.body;
          const result = await memoryService.sessionStart(
            workspace_id,
            user_id,
            context,
            limit ?? 10,
          );
          res.json(result);
          break;
        }
        default:
          res.status(404).json({ error: `Unknown tool: ${toolName}` });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
```

- [ ] **Step 3: Create `src/routes/index.ts`**

```typescript
import type { Express } from "express";
import type { MemoryService } from "../services/memory-service.js";
import { healthRouter } from "./health.js";
import { createApiToolsRouter } from "./api-tools.js";

export function registerRoutes(
  app: Express,
  memoryService: MemoryService,
): void {
  app.use(healthRouter);
  app.use(createApiToolsRouter(memoryService));
}
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/
git commit -m "feat: add REST route handlers for health and hook API"
```

---

### Task 3: Rewrite server.ts for Streamable HTTP

**Files:**

- Modify: `src/server.ts`

This is the core change. Replace the stdio transport with Express + StreamableHTTPServerTransport.

- [ ] **Step 1: Rewrite `src/server.ts`**

Replace the entire file with:

```typescript
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createEmbeddingProvider } from "./providers/embedding/index.js";
import { DrizzleMemoryRepository } from "./repositories/memory-repository.js";
import { DrizzleProjectRepository } from "./repositories/project-repository.js";
import { DrizzleCommentRepository } from "./repositories/comment-repository.js";
import {
  DrizzleSessionTrackingRepository,
  DrizzleSessionRepository,
} from "./repositories/session-repository.js";
import { MemoryService } from "./services/memory-service.js";
import { registerAllTools } from "./tools/index.js";
import { registerMemoryGuidance } from "./prompts/memory-guidance.js";
import { registerRoutes } from "./routes/index.js";
import { logger } from "./utils/logger.js";

async function main() {
  logger.info(`v${config.version} starting...`);

  // Initialize database
  const db = createDb(config.databaseUrl);
  await runMigrations(db);
  logger.info("Database connected, migrations applied");

  // Initialize embedding provider
  const embedder = createEmbeddingProvider();
  logger.info(
    `Embedding provider: ${embedder.modelName} (${embedder.dimensions}d)`,
  );

  // Initialize repositories and service
  const memoryRepo = new DrizzleMemoryRepository(db);
  const projectRepo = new DrizzleProjectRepository(db);
  const commentRepo = new DrizzleCommentRepository(db);
  const sessionRepo = new DrizzleSessionTrackingRepository(db);
  const sessionLifecycleRepo = new DrizzleSessionRepository(db);
  const memoryService = new MemoryService(
    memoryRepo,
    projectRepo,
    embedder,
    commentRepo,
    sessionRepo,
    sessionLifecycleRepo,
  );

  // Factory: creates a fresh MCP server per session (tools + prompts registered)
  function createMcpServerForSession(): McpServer {
    const server = new McpServer({
      name: "agentic-brain",
      version: config.version,
    });
    registerAllTools(server, memoryService);
    registerMemoryGuidance(server);
    return server;
  }

  // Express app with DNS rebinding protection
  const app = createMcpExpressApp();

  // Register REST routes (health + hook API)
  registerRoutes(app, memoryService);

  // Session transport map
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // MCP Streamable HTTP: POST /mcp
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) delete transports[sid];
        };
        const server = createMcpServerForSession();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID" },
          id: null,
        });
      }
    } catch (error) {
      logger.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // MCP Streamable HTTP: GET /mcp (SSE stream)
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // MCP Streamable HTTP: DELETE /mcp (session termination)
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // Start HTTP server
  app.listen(config.port, () => {
    logger.info(`Server ready on http://0.0.0.0:${config.port}/mcp`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    for (const sid of Object.keys(transports)) {
      await transports[sid].close();
      delete transports[sid];
    }
    await db.$client.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify server starts**

Run:

```bash
docker compose up -d --wait && npm start
```

Expected: Server logs `Server ready on http://0.0.0.0:19898/mcp` to stderr.

- [ ] **Step 3: Test health endpoint**

Run:

```bash
curl -s http://localhost:19898/health
```

Expected: `{"status":"ok"}`

- [ ] **Step 4: Test REST API for session start**

Run:

```bash
curl -s -X POST http://localhost:19898/api/tools/memory_session_start \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"agent-brain","user_id":"chris","limit":5}'
```

Expected: JSON response with `data` and `meta` fields (the Envelope structure).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: replace stdio transport with Streamable HTTP"
```

---

### Task 4: Update package.json Scripts and Remove bin

**Files:**

- Modify: `package.json`
- Delete: `bin/agentic-brain.mjs`

- [ ] **Step 1: Update npm scripts in `package.json`**

Change:

```json
"dev": "docker compose up -d --wait && npx drizzle-kit migrate && EMBEDDING_PROVIDER=ollama EMBEDDING_DIMENSIONS=768 tsx watch src/server.ts",
```

To:

```json
"dev": "docker compose up -d --wait && npx drizzle-kit migrate && EMBEDDING_PROVIDER=ollama EMBEDDING_DIMENSIONS=768 OLLAMA_BASE_URL=http://localhost:11434 tsx watch src/server.ts",
```

(The `dev` script already starts `tsx watch src/server.ts` — it now starts the HTTP server since `server.ts` was rewritten. Add `OLLAMA_BASE_URL` explicitly since when running outside Docker the default `localhost` is correct but being explicit is clearer.)

Update the `inspect` script:

```json
"inspect": "npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:19898/mcp"
```

- [ ] **Step 2: Remove `"bin"` field from `package.json`**

Delete the `"bin"` block:

```json
"bin": {
  "agentic-brain": "bin/agentic-brain.mjs"
},
```

- [ ] **Step 3: Delete `bin/agentic-brain.mjs`**

```bash
rm bin/agentic-brain.mjs && rmdir bin
```

- [ ] **Step 4: Commit**

```bash
git add package.json && git rm bin/agentic-brain.mjs
git commit -m "chore: remove bin entry point, update npm scripts for HTTP server"
```

---

### Task 5: Create Dockerfile

**Files:**

- Create: `Dockerfile`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY scripts/ ./scripts/
EXPOSE 19898
CMD ["npx", "tsx", "src/server.ts"]
```

Note: `curl` is installed for the Docker healthcheck. `node:22-slim` doesn't include it by default.

- [ ] **Step 2: Create `.dockerignore`**

```
node_modules
.git
.env
*.md
docs/
hooks/
bin/
.planning/
.idea/
```

- [ ] **Step 3: Test Docker build**

```bash
docker build -t agentic-brain .
```

Expected: Build completes successfully.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat: add Dockerfile for containerized HTTP server"
```

---

### Task 6: Create docker-compose.prod.yml

**Files:**

- Create: `docker-compose.prod.yml`

- [ ] **Step 1: Create `docker-compose.prod.yml`**

```yaml
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

- [ ] **Step 2: Test full stack**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

Expected: All three services start. `agentic-brain` logs `Server ready on http://0.0.0.0:19898/mcp`.

- [ ] **Step 3: Verify health from host**

```bash
curl -s http://localhost:19898/health
```

Expected: `{"status":"ok"}`

- [ ] **Step 4: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat: add docker-compose.prod.yml for full-stack deployment"
```

---

### Task 7: Rewrite Session-Start Hook

**Files:**

- Modify: `hooks/memory-session-start.sh`

- [ ] **Step 1: Rewrite `hooks/memory-session-start.sh`**

Replace the entire file with:

```bash
#!/bin/bash
# Claude Code SessionStart Hook: Load agent-brain memories
# Calls the REST API on the persistent HTTP server

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

USER_ID=$(whoami)
WORKSPACE_ID=$(basename "$CWD")

# Check server health — fail gracefully if server is down
if ! curl -sf http://localhost:19898/health >/dev/null 2>&1; then
  exit 0
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

- [ ] **Step 2: Verify hook works (server must be running)**

```bash
echo '{"cwd":"/Users/chris/dev/agent-brain"}' | bash hooks/memory-session-start.sh
```

Expected: JSON output with `hookSpecificOutput` containing memories.

- [ ] **Step 3: Commit**

```bash
git add hooks/memory-session-start.sh
git commit -m "feat: rewrite session-start hook to use HTTP REST API"
```

---

### Task 8: Update Settings Snippet and Claude Code Config

**Files:**

- Modify: `hooks/settings-snippet.json`

- [ ] **Step 1: Update `hooks/settings-snippet.json`**

Replace the file with:

```json
{
  "mcpServers": {
    "agentic-brain": {
      "url": "http://localhost:19898/mcp"
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/memory-session-start.sh",
            "statusMessage": "Loading memories..."
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/memory-guard.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/memory-session-review.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Update `~/.claude/settings.json` on the dev machine**

Replace the `mcpServers.agentic-brain` entry:

From:

```json
"agentic-brain": {
  "command": "npx",
  "args": ["tsx", "/Users/chris/dev/agent-brain/src/server.ts"]
}
```

To:

```json
"agentic-brain": {
  "url": "http://localhost:19898/mcp"
}
```

- [ ] **Step 3: Commit repo changes**

```bash
git add hooks/settings-snippet.json
git commit -m "feat: update settings snippet for Streamable HTTP MCP config"
```

---

### Task 9: End-to-End Verification

No files changed — this task validates everything works together.

- [ ] **Step 1: Start full stack**

```bash
cd /Users/chris/dev/agent-brain
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Wait for all services to be healthy:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Expected: All three services show `healthy` status.

- [ ] **Step 2: Test health endpoint**

```bash
curl -s http://localhost:19898/health
```

Expected: `{"status":"ok"}`

- [ ] **Step 3: Test REST API**

```bash
curl -s -X POST http://localhost:19898/api/tools/memory_session_start \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"agent-brain","user_id":"chris","limit":5}'
```

Expected: JSON envelope with memories.

- [ ] **Step 4: Test hook**

```bash
echo '{"cwd":"/Users/chris/dev/agent-brain"}' | bash hooks/memory-session-start.sh
```

Expected: JSON with `hookSpecificOutput`.

- [ ] **Step 5: Test MCP endpoint with Claude Code**

Start a new Claude Code session in any project directory. Verify:

1. Claude Code connects to the MCP server (no spawn, just HTTP)
2. Memory tools are available (`memory_search`, `memory_create`, etc.)
3. Session-start hook loads memories via the REST API

- [ ] **Step 6: Shut down and clean up**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
```
