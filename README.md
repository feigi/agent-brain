# Agent Brain

Long-term memory for AI agents. Agents read relevant memories at session start, write new insights during sessions, and team members can manually save context. Exposed as an MCP server — works with Claude Code, GitHub Copilot, Cursor, and any MCP-compatible agent.

**Core value:** agents remember what matters across sessions. No team knowledge is lost because a conversation ended.

---

## How it works

```
┌─────────────────────────────────────────────────────┐
│                   MCP Client                        │
│         (Claude Code, Cursor, any agent)            │
└───────────────────┬─────────────────────────────────┘
                    │ HTTP (JSON-RPC)
┌───────────────────▼─────────────────────────────────┐
│                Agent Brain MCP Server                │
│                                                     │
│  Tools                      Services                │
│  ├─ memory_session_start     ├─ MemoryService        │
│  ├─ memory_search            ├─ ConsolidationService │
│  ├─ memory_create            ├─ FlagService          │
│  ├─ memory_get               ├─ AuditService         │
│  ├─ memory_update            ├─ EmbeddingProvider    │
│  ├─ memory_verify            ├─ RelationshipService  │
│  ├─ memory_comment           └─ Repositories        │
│  ├─ memory_archive                                  │
│  ├─ memory_list              Providers              │
│  ├─ memory_list_stale        ├─ Amazon Titan V2      │
│  ├─ memory_list_recent       ├─ Ollama (local)       │
│  ├─ memory_resolve_flag      └─ Mock (dev/test)      │
│  ├─ memory_relate                                   │
│  ├─ memory_unrelate                                 │
│  └─ memory_relationships                            │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│            PostgreSQL + pgvector                    │
│                                                     │
│  workspaces   memories (+ HNSW index)               │
│  sessions     session_tracking                      │
│  comments     flags       audit_log                 │
│  relationships                                      │
└─────────────────────────────────────────────────────┘
```

### Session flow

1. **Session start** — agent calls `memory_session_start` with the workspace, user, and what it's working on. Returns the most relevant memories ranked by semantic similarity + recency.
2. **During session** — agent calls `memory_search` for ad-hoc lookups, or `memory_create` to save new insights. A write budget (default 10/session) prevents runaway writes.
3. **Team collaboration** — team members call `memory_comment` to add context to existing memories, `memory_verify` to confirm still-accurate notes, and `memory_archive` to retire stale ones. `memory_list_stale` surfaces memories that haven't been verified in a while.
4. **Consolidation** — a scheduled background job (opt-in) detects duplicate, superseded, and stale memories. Near-exact duplicates are auto-archived; borderline cases are flagged for review. Flags are surfaced to the agent at session start so the user can resolve them.

### Memory anatomy

Every memory has:

| Field       | Description                                                                            |
| ----------- | -------------------------------------------------------------------------------------- |
| `title`     | Short label for display                                                                |
| `content`   | The actual knowledge                                                                   |
| `type`      | `fact` · `decision` · `learning` · `pattern` · `preference` · `architecture`           |
| `scope`     | `workspace` (shared with team) · `user` (private to you) · `project` (cross-workspace) |
| `tags`      | Free-form labels                                                                       |
| `author`    | Who created it                                                                         |
| `source`    | `manual` · `agent-auto` · etc.                                                         |
| `embedding` | Vector for semantic search (dimensions depend on provider)                             |

---

## Quickstart

### Prerequisites

- Docker (runs everything — Postgres, Ollama, and the server itself)
- Node.js 22+ (only needed if developing Agent Brain or running it outside Docker)
- AWS credentials with Bedrock access (only needed when using Titan embeddings in production)

### 1. Install

```bash
git clone https://github.com/feigi/agent-brain.git
cd agent-brain
```

If running outside Docker (local development), also install dependencies:

```bash
npm install
```

### 2. Configure

For Docker-only usage, edit the environment variables directly in `docker-compose.prod.yml`.

For local development, copy and edit the environment file:

```bash
cp .env.example .env
```

Key variables:

```env
# Project identifier (required) — identifies this server deployment
PROJECT_ID=my-project

# Database (defaults work with docker compose)
DATABASE_URL=postgresql://agentic:agentic@localhost:5432/agent_brain

# Embedding provider: "ollama" for local dev, "titan" for production
EMBEDDING_PROVIDER=ollama

# AWS (required when EMBEDDING_PROVIDER=titan)
AWS_REGION=us-east-1
```

### 3. Start

**Docker — fully self-contained (no Node.js required):**

```bash
docker compose -f docker-compose.prod.yml up -d --wait
```

This runs everything in Docker — Postgres, Ollama, and the Agent Brain server. The server is exposed at `http://localhost:19898`. Edit the environment variables in `docker-compose.prod.yml` to configure `PROJECT_ID` and other settings. First startup downloads the Ollama embedding model (~274MB).

**Local development (Node.js + Docker for infrastructure):**

```bash
npm run dev
```

Starts Postgres + Ollama via Docker Compose, runs database migrations, and starts the MCP server on `http://localhost:19898` with hot reload. Use this when you're working on Agent Brain itself.

**Minimal local setup (mock embeddings — fastest, no Ollama download):**

```bash
docker compose up -d --wait        # Start Postgres only
npx drizzle-kit migrate             # Run migrations
EMBEDDING_PROVIDER=mock npm start   # Start with mock embeddings
```

Mock mode uses random vectors — search results won't be semantically meaningful, but all tools work. Good for testing the MCP integration.

### 4. Set up with Claude Code

**Step 1: Add the MCP server**

Make sure Agent Brain is running (see [Start](#3-start)), then add to `~/.claude/settings.json` (global) or project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "agent-brain": {
      "url": "http://localhost:19898/mcp"
    }
  }
}
```

**Step 2: Add hooks (optional)**

Four hooks make Claude Code work seamlessly with Agent Brain: automatic memory loading at session start, a guard that prevents writes to Claude Code's built-in file-based memory, periodic nudges to save memories mid-session, and a session-review prompt at session end.

**Prerequisites:** `jq` installed (`brew install jq` on macOS).

```bash
mkdir -p ~/.claude/hooks
cp hooks/claude/memory-session-start.sh ~/.claude/hooks/
cp hooks/claude/memory-guard.sh ~/.claude/hooks/
cp hooks/claude/memory-nudge.sh ~/.claude/hooks/
cp hooks/claude/memory-session-review.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/memory-*.sh
```

Merge the entries from `hooks/claude/settings-snippet.json` into your `~/.claude/settings.json`:

| Hook                                       | Purpose                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **SessionStart** `memory-session-start.sh` | Loads relevant memories into the session via `additionalContext`                                     |
| **PreToolUse** `memory-guard.sh`           | Blocks Write/Edit/MultiEdit to `~/.claude/projects/*/memory/*`, redirecting to agent-brain MCP tools |
| **PostToolUse** `memory-nudge.sh`          | Periodically reminds Claude to save notable decisions or conventions via `additionalContext`         |
| **Stop** `memory-session-review.sh`        | Prompts Claude to reflect and save learnings before ending a session                                 |

The hooks connect to Agent Brain at `http://localhost:19898` by default. Set the `AGENT_BRAIN_URL` environment variable to override (e.g. `export AGENT_BRAIN_URL=http://my-server:3000`).

**Step 3: Add instructions to your CLAUDE.md**

Create or edit `~/.claude/CLAUDE.md` (global) and paste the contents of [`hooks/claude/claude-md-snippet.md`](hooks/claude/claude-md-snippet.md). It tells Claude Code to use agent-brain instead of the built-in file-based memory.

### 5. Set up with GitHub Copilot CLI

**Step 1: Add the MCP server**

Make sure Agent Brain is running (see [Start](#3-start)), then merge into your `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "agent-brain": {
      "type": "http",
      "url": "http://localhost:19898/mcp"
    }
  }
}
```

**Step 2: Add hooks (optional)**

**Prerequisites:** `jq` installed (`brew install jq` on macOS), Copilot CLI v0.0.422+.

Copy the hook scripts and configuration into your project:

```bash
mkdir -p .github/hooks
cp hooks/copilot/hooks.json .github/hooks/hooks.json
cp hooks/copilot/memory-session-start.sh .github/hooks/
cp hooks/copilot/memory-nudge.sh .github/hooks/
cp hooks/copilot/memory-session-end.sh .github/hooks/
chmod +x .github/hooks/memory-*.sh
```

A ready-made MCP server configuration snippet is also available at [`hooks/copilot/mcp-snippet.json`](hooks/copilot/mcp-snippet.json).

| Hook                                       | Purpose                                        |
| ------------------------------------------ | ---------------------------------------------- |
| **sessionStart** `memory-session-start.sh` | Pre-warms the Agent Brain session via REST API |
| **postToolUse** `memory-nudge.sh`          | Counter-based tool usage audit log             |
| **sessionEnd** `memory-session-end.sh`     | Cleans up temp files from the session          |

The hooks connect to Agent Brain at `http://localhost:19898` by default. Set the `AGENT_BRAIN_URL` environment variable to override.

> **Important:** Copilot CLI's `sessionEnd` hook fires after the conversation ends — its output is ignored and cannot prompt the agent to save memories. Unlike Claude Code's `Stop` hook, there is no reliable automatic trigger for end-of-session memory saving. **The only way to ensure memories are saved is to say goodbye** (e.g. "bye", "done", "that's all"). The agent recognizes these signals and will save a session summary. Make it a habit.

**Step 3: Add custom instructions**

Create `.github/copilot-instructions.md` in your project root and paste the contents of [`hooks/copilot/instructions-snippet.md`](hooks/copilot/instructions-snippet.md). Copilot CLI also reads `CLAUDE.md` and `AGENTS.md` from the repository root.

For more details on hooks and differences from Claude Code, see [hooks/README.md](hooks/README.md).

### 6. Use the MCP Inspector (dev/debug)

```bash
npm run inspect
```

Opens a visual UI to invoke tools and inspect responses directly.

### Embedding providers

**Ollama (default)** -- Runs `nomic-embed-text` locally. Real semantic search without AWS credentials. Started automatically by `npm run dev`.

```bash
EMBEDDING_PROVIDER=ollama
EMBEDDING_DIMENSIONS=768
OLLAMA_BASE_URL=http://localhost:11434  # default
OLLAMA_MODEL=nomic-embed-text           # default
```

First startup downloads the model (~274MB).

**Mock** -- Returns random vectors. Useful for CI or testing tool behavior without real embeddings. No Docker required beyond Postgres.

```bash
EMBEDDING_PROVIDER=mock
```

**Titan V2 (production)** -- Amazon Titan Text Embeddings V2 via Bedrock. Requires AWS credentials.

```bash
EMBEDDING_PROVIDER=titan
EMBEDDING_DIMENSIONS=512
AWS_REGION=us-east-1
```

> **Note:** When switching between providers with different dimensions, you must re-embed existing memories or start with a fresh database, as vector dimensions are fixed at index creation time.

---

## MCP Tools reference

| Tool                   | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `memory_session_start` | Load relevant memories at session start (call this first) |
| `memory_search`        | Semantic search within a workspace                        |
| `memory_create`        | Save a new memory                                         |
| `memory_get`           | Fetch a specific memory by ID                             |
| `memory_update`        | Edit an existing memory                                   |
| `memory_verify`        | Mark a memory as still accurate                           |
| `memory_comment`       | Add a threaded comment to a memory                        |
| `memory_archive`       | Retire a memory that's no longer relevant                 |
| `memory_list`          | List memories with filters                                |
| `memory_list_stale`    | Find memories that need review                            |
| `memory_list_recent`   | Most recently created/updated memories                    |
| `memory_consolidate`   | Run a full consolidation pass on demand (no cron needed)  |
| `memory_resolve_flag`  | Resolve a consolidation flag (accept, dismiss, or defer)  |
| `memory_relate`        | Create a directional relationship between two memories    |
| `memory_unrelate`      | Remove a relationship                                     |
| `memory_relationships` | List relationships for a memory                           |

All tools require `workspace_id` and `user_id`. Workspaces are created automatically on first use.

---

## Memory consolidation

Over time, agents and users create memories that overlap or go stale. The consolidation engine detects these issues automatically.

**Scheduled:** set `CONSOLIDATION_ENABLED=true` to run on a cron schedule (default: 3 AM daily). Uses a PostgreSQL advisory lock to prevent concurrent runs.

**On demand:** call the `memory_consolidate` MCP tool to trigger a consolidation pass at any time (no cron required).

### What it does

The engine runs two tiers of detection:

1. **Content subset check** — if one memory's text is contained entirely within another (after normalization), the shorter one is auto-archived.
2. **Embedding similarity** — pairwise cosine similarity across memories in the same scope:
   - **≥ 0.95** — near-exact duplicate, auto-archived (non-user-scoped only)
   - **0.90–0.95** — flagged as probable duplicate for human review

Cross-scope checks also run: workspace memories are compared against project-scoped memories to detect superseded or overridden content. Memories not verified in over 30 days (configurable) are flagged for re-verification.

### How flags work

Flags are surfaced to agents at session start (up to 5 per session, configurable). The agent presents them to the user with suggested actions:

- **duplicate** — offer to archive the redundant memory
- **superseded** — workspace memory duplicates a project-scoped one; offer to archive
- **verify** — ask if the memory is still accurate

The user resolves each flag via `memory_resolve_flag` with one of: `accepted` (acted on), `dismissed` (false positive), or `deferred` (skip for now — reappears next session).

---

## Memory relationships

Memories can be linked with directional, typed relationships to capture how knowledge evolves over time.

### Creating relationships

```
memory_relate({ source_id, target_id, type, user_id })
memory_unrelate({ id, user_id })
memory_relationships({ memory_id, user_id, direction: "outgoing" | "incoming" | "both" })
```

### Well-known relationship types

| Type          | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `overrides`   | Source supersedes or replaces the target                    |
| `duplicates`  | Source is a near-exact duplicate of the target              |
| `implements`  | Source implements a decision or pattern described in target |
| `refines`     | Source adds detail or nuance to the target                  |
| `contradicts` | Source conflicts with the target — needs human resolution   |

The `type` field is freeform — any descriptive string is valid. The well-known types above have consistent semantics across tools and the consolidation engine.

### How relationships work

- **Directional** — every relationship has an explicit source and target (`source_id → target_id`).
- **Freeform type** — use well-known types for interoperability, or any string for novel relationships.
- **Included in `memory_get`** — fetching a memory returns its outgoing and incoming relationships with a `direction` field.
- **Surfaced in `memory_session_start`** — when two or more returned memories are linked, their relationships appear in `meta.relationships` so agents can understand context without extra queries.
- **Soft-deleted on archive** — when either memory in a relationship is archived, the relationship's `archived_at` is set and it is excluded from all queries.
- **Consolidation-created** — the consolidation engine automatically creates `duplicates` and `overrides` relationships when it detects near-duplicate or superseded memories, providing a traceable record of its decisions.

---

## Development

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# Generate a migration after schema changes
npm run db:generate

# Apply migrations
npm run db:migrate

# Browse the database
npm run db:studio

# Seed with sample data
npm run seed

# Backfill relationships from pre-existing consolidation flags (one-time, idempotent)
npm run migrate:flag-relationships
```

### Project structure

```
src/
├── server.ts           # MCP server entrypoint
├── config.ts           # Environment config
├── db/
│   ├── schema.ts       # Drizzle schema (tables + HNSW index)
│   └── migrate.ts      # Auto-migration on startup
├── routes/             # HTTP routes (health, REST API)
├── tools/              # One file per MCP tool
├── scheduler/          # Cron-based consolidation job
├── services/
│   ├── memory-service.ts        # Core business logic
│   ├── consolidation-service.ts # Duplicate/superseded detection
│   ├── flag-service.ts          # Flag lifecycle management
│   ├── relationship-service.ts  # Relationship CRUD + access control
│   └── audit-service.ts         # Audit trail for archival actions
├── repositories/       # Data access layer (Drizzle)
├── providers/
│   └── embedding/      # Titan V2, Ollama + mock implementations
├── prompts/            # System prompts (memory guidance)
├── types/              # Shared type definitions
└── utils/              # Scoring, validation, logging, IDs
```

---

## Stack

| Layer      | Technology                                    |
| ---------- | --------------------------------------------- |
| MCP server | `@modelcontextprotocol/sdk` (Streamable HTTP) |
| Language   | TypeScript 5.9 + Node.js 22 LTS               |
| Database   | PostgreSQL 17 + pgvector 0.8 (HNSW)           |
| ORM        | Drizzle ORM 0.45                              |
| Embeddings | Amazon Titan Text V2 (512d, $0.02/1M tokens)  |
| Validation | Zod 4                                         |
| Tests      | Vitest 4                                      |

---

## Configuration reference

| Variable                               | Default                                                   | Description                                                              |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `PROJECT_ID`                           | —                                                         | **Required.** Deployment-level project identifier (1 server = 1 project) |
| `DATABASE_URL`                         | `postgresql://agentic:agentic@localhost:5432/agent_brain` | Postgres connection string                                               |
| `EMBEDDING_PROVIDER`                   | `mock`                                                    | `mock`, `ollama`, or `titan`                                             |
| `AWS_REGION`                           | `us-east-1`                                               | AWS region for Bedrock                                                   |
| `WRITE_BUDGET_PER_SESSION`             | `10`                                                      | Max memories an agent can create per session                             |
| `DUPLICATE_THRESHOLD`                  | `0.90`                                                    | Cosine similarity above which a new memory is rejected as duplicate      |
| `RECENCY_HALF_LIFE_DAYS`               | `14`                                                      | Half-life for recency score decay in search ranking                      |
| `EMBEDDING_DIMENSIONS`                 | `768`                                                     | Vector dimensions (512 for Titan, 768 for nomic-embed-text)              |
| `OLLAMA_BASE_URL`                      | `http://localhost:11434`                                  | Ollama API endpoint                                                      |
| `OLLAMA_MODEL`                         | `nomic-embed-text`                                        | Ollama model for embeddings                                              |
| `HOST`                                 | `127.0.0.1`                                               | Server bind address                                                      |
| `PORT`                                 | `19898`                                                   | Server port                                                              |
| `EMBEDDING_TIMEOUT_MS`                 | `10000`                                                   | Timeout for embedding API calls                                          |
| `CONSOLIDATION_ENABLED`                | `false`                                                   | Enable the scheduled consolidation job                                   |
| `CONSOLIDATION_CRON`                   | `0 3 * * *`                                               | Cron schedule for consolidation (default: 3 AM daily)                    |
| `CONSOLIDATION_AUTO_ARCHIVE_THRESHOLD` | `0.95`                                                    | Similarity above which duplicates are auto-archived                      |
| `CONSOLIDATION_FLAG_THRESHOLD`         | `0.90`                                                    | Similarity above which pairs are flagged as probable duplicates          |
| `CONSOLIDATION_VERIFY_AFTER_DAYS`      | `30`                                                      | Days without verification before a memory is flagged for review          |
| `CONSOLIDATION_MAX_FLAGS_PER_SESSION`  | `5`                                                       | Max flags surfaced to agents per session start                           |
