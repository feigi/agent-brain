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
                    │ stdio (JSON-RPC)
┌───────────────────▼─────────────────────────────────┐
│                Agent Brain MCP Server                │
│                                                     │
│  Tools                      Services                │
│  ├─ memory_session_start     ├─ MemoryService        │
│  ├─ memory_search            ├─ EmbeddingProvider    │
│  ├─ memory_create            └─ Repositories        │
│  ├─ memory_get                                      │
│  ├─ memory_update            Providers              │
│  ├─ memory_verify            ├─ Amazon Titan V2      │
│  ├─ memory_comment           ├─ Ollama (local)       │
│  ├─ memory_archive           └─ Mock (dev/test)      │
│  ├─ memory_list                                     │
│  ├─ memory_list_stale                               │
│  └─ memory_list_recent                              │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│            PostgreSQL + pgvector                    │
│                                                     │
│  projects   memories (+ HNSW index)                 │
│  sessions   session_tracking                        │
│  comments                                           │
└─────────────────────────────────────────────────────┘
```

### Session flow

1. **Session start** — agent calls `memory_session_start` with the project, user, and what it's working on. Returns the most relevant memories ranked by semantic similarity + recency.
2. **During session** — agent calls `memory_search` for ad-hoc lookups, or `memory_create` to save new insights. A write budget (default 10/session) prevents runaway writes.
3. **Team collaboration** — team members call `memory_comment` to add context to existing memories, `memory_verify` to confirm still-accurate notes, and `memory_archive` to retire stale ones. `memory_list_stale` surfaces memories that haven't been verified in a while.

### Memory anatomy

Every memory has:

| Field       | Description                                                                  |
| ----------- | ---------------------------------------------------------------------------- |
| `title`     | Short label for display                                                      |
| `content`   | The actual knowledge                                                         |
| `type`      | `fact` · `decision` · `learning` · `pattern` · `preference` · `architecture` |
| `scope`     | `project` (shared) or `user` (private to you)                                |
| `tags`      | Free-form labels                                                             |
| `author`    | Who created it                                                               |
| `source`    | `manual` · `agent-auto` · etc.                                               |
| `embedding` | 512-dim vector for semantic search                                           |

---

## Quickstart

### Prerequisites

- Docker (for local Postgres + Ollama)
- Node.js 22+ (only if running from a local clone)

### 1. Start the database

```bash
docker compose up -d --wait
```

This starts Postgres with pgvector. If using Ollama for embeddings (recommended for local dev), it starts that too.

> **Don't have the repo cloned?** Grab just the compose file:
>
> ```bash
> curl -O https://raw.githubusercontent.com/feigi/agent-brain/main/docker-compose.yml
> docker compose up -d --wait
> ```

### 2. Connect to your MCP client

Agent Brain runs as an MCP server over stdio. Your client starts it automatically — no global install needed.

**Claude Code** — add to `~/.claude/settings.json` (global) or `.claude/settings.json` (per-project):

```json
{
  "mcpServers": {
    "agent-brain": {
      "command": "npx",
      "args": ["-y", "github:feigi/agent-brain"],
      "env": {
        "DATABASE_URL": "postgresql://agentic:agentic@localhost:5432/agent_brain",
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_DIMENSIONS": "768"
      }
    }
  }
}
```

**From a local clone** — if you've cloned the repo and want to run from source:

```json
{
  "mcpServers": {
    "agent-brain": {
      "command": "npx",
      "args": ["tsx", "/path/to/agent-brain/src/server.ts"],
      "env": {
        "DATABASE_URL": "postgresql://agentic:agentic@localhost:5432/agent_brain",
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_DIMENSIONS": "768"
      }
    }
  }
}
```

Database migrations run automatically on first connection. For production with Titan embeddings, set `EMBEDDING_PROVIDER=titan` and ensure `AWS_REGION` and AWS credentials are available.

### 5. Integrate with Claude Code (optional)

Three hooks make Claude Code work seamlessly with Agent Brain: automatic memory loading at session start, a guard that prevents writes to Claude Code's built-in file-based memory, and a session-review prompt at session end.

**Prerequisites:** `jq` installed (`brew install jq` on macOS).

#### Step 1: Copy hook scripts

```bash
mkdir -p ~/.claude/hooks
cp hooks/memory-session-start.sh ~/.claude/hooks/
cp hooks/memory-guard.sh ~/.claude/hooks/
cp hooks/memory-session-review.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/memory-session-start.sh ~/.claude/hooks/memory-guard.sh ~/.claude/hooks/memory-session-review.sh
```

#### Step 2: Add hooks to settings

Merge the entries from `hooks/settings-snippet.json` into your `~/.claude/settings.json`:

| Hook                                       | Purpose                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **SessionStart** `memory-session-start.sh` | Loads relevant memories into the session via `additionalContext`                                     |
| **PreToolUse** `memory-guard.sh`           | Blocks Write/Edit/MultiEdit to `~/.claude/projects/*/memory/*`, redirecting to agent-brain MCP tools |
| **Stop** `memory-session-review.sh`        | Prompts Claude to reflect and save learnings before ending a session                                 |

#### Step 3: Add instructions to your CLAUDE.md

Create or edit `~/.claude/CLAUDE.md` (global) and paste this snippet. It tells Claude Code to use agent-brain instead of the built-in file-based memory:

```markdown
## Memory System

This user uses **agent-brain** (MCP server) as their sole memory system across all projects. Do NOT use Claude Code's built-in file-based auto-memory system (`~/.claude/projects/**/memory/`). All memory operations go through agent-brain MCP tools.

**Reading memory:** Relevant memories are loaded automatically at session start via the SessionStart hook. Use `memory_search` for additional lookups during the session.

**Writing memory:** Use `memory_create` to save learnings, decisions, conventions, and patterns. Never write to MEMORY.md or create files in the memory/ directory.

### Available Tools

- **memory_search** -- Search for relevant memories. Call with a query describing what you need.
- **memory_create** -- Save a new memory from important context the user shares.
- **memory_get** -- Read a specific memory by ID.
- **memory_update** -- Modify an existing memory.
- **memory_comment** -- Append a comment to an existing memory (turns it into a thread).
- **memory_verify** -- Confirm a memory is still accurate (updates verified_at).
- **memory_archive** -- Archive a memory that is no longer relevant.
- **memory_list_stale** -- List memories that need review (old or unverified).

### Identity Parameters

- **`user_id`**: The OS username, i.e. the output of `whoami`. This is the user's identity across all memory tools.
- **`project_id`**: The repository directory name (e.g., `agent-brain` for `/Users/chris/dev/agent-brain`).

### When to Call `memory_search`

**Call `memory_search` before actions that affect shared systems.** This includes:

1. **The user asks about notes, context, or team knowledge** -- e.g. "any notes?", "what should I know?"
2. **Before actions that affect shared infrastructure** -- deploys, database migrations, credential rotation, etc.
3. **Before running shared/integration tests** (e.g. E2E, load tests) -- but NOT local unit tests or builds

**Do NOT search for purely local actions** like editing files, installing dependencies, running local builds, linting, or formatting.

### When the User Shares Important Context

If the user mentions decisions, temporary changes, or gotchas that the team should know about, suggest saving a memory with `memory_create`. Always confirm before saving.

### Presenting Memories

Always **number** memories and include **author**, **date**, **title**, **type**, and **scope**. The user may refer to memories by number (e.g. "archive memory 2", "comment on 1").
```

### 5b. Integrate with GitHub Copilot (optional)

GitHub Copilot's coding agent has its own instruction and hook system that lives in `.github/`. The concepts are the same as the Claude Code integration above, just different file locations.

#### Add custom instructions

Create `.github/copilot-instructions.md` in your project root. This is Copilot's equivalent of `CLAUDE.md` — it tells the Copilot coding agent when and how to use the memory tools.

A ready-to-use instructions file is included in this repo at [`.github/copilot-instructions.md`](.github/copilot-instructions.md).

#### Add a session-start hook (optional)

Copilot supports hooks via `.github/hooks/hooks.json`. You can add a `sessionStart` hook to automatically trigger memory retrieval at the beginning of each coding agent session.

Create `.github/hooks/hooks.json`:

```json
{
  "hooks": [
    {
      "event": "sessionStart",
      "script": {
        "type": "command",
        "bash": "echo 'Agent Brain MCP server is available. Call memory_session_start at the beginning of each session to load relevant memories.'"
      }
    }
  ]
}
```

> **Note:** Copilot hooks use a different format from Claude Code hooks. See [GitHub's hooks documentation](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/use-hooks) for details.

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
| `memory_search`        | Semantic search within a project                          |
| `memory_create`        | Save a new memory                                         |
| `memory_get`           | Fetch a specific memory by ID                             |
| `memory_update`        | Edit an existing memory                                   |
| `memory_verify`        | Mark a memory as still accurate                           |
| `memory_comment`       | Add a threaded comment to a memory                        |
| `memory_archive`       | Retire a memory that's no longer relevant                 |
| `memory_list`          | List memories with filters                                |
| `memory_list_stale`    | Find memories that need review                            |
| `memory_list_recent`   | Most recently created/updated memories                    |

All tools require `project_id` and `user_id`. Projects are created automatically on first use.

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
```

### Project structure

```
src/
├── server.ts           # MCP server entrypoint
├── config.ts           # Environment config
├── db/
│   ├── schema.ts       # Drizzle schema (tables + HNSW index)
│   └── migrate.ts      # Auto-migration on startup
├── tools/              # One file per MCP tool
├── services/
│   └── memory-service.ts  # Core business logic
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
| MCP server | `@modelcontextprotocol/sdk` (stdio transport) |
| Language   | TypeScript 5.9 + Node.js 22 LTS               |
| Database   | PostgreSQL 17 + pgvector 0.8 (HNSW)           |
| ORM        | Drizzle ORM 0.45                              |
| Embeddings | Amazon Titan Text V2 (512d, $0.02/1M tokens)  |
| Validation | Zod 4                                         |
| Tests      | Vitest 4                                      |

---

## Configuration reference

| Variable                   | Default                                                   | Description                                                         |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`             | `postgresql://agentic:agentic@localhost:5432/agent_brain` | Postgres connection string                                          |
| `EMBEDDING_PROVIDER`       | `mock`                                                    | `mock`, `ollama`, or `titan`                                        |
| `AWS_REGION`               | `us-east-1`                                               | AWS region for Bedrock                                              |
| `WRITE_BUDGET_PER_SESSION` | `10`                                                      | Max memories an agent can create per session                        |
| `DUPLICATE_THRESHOLD`      | `0.90`                                                    | Cosine similarity above which a new memory is rejected as duplicate |
| `RECENCY_HALF_LIFE_DAYS`   | `14`                                                      | Half-life for recency score decay in search ranking                 |
| `EMBEDDING_DIMENSIONS`     | `512`                                                     | Vector dimensions (512 for Titan, 768 for nomic-embed-text)         |
| `OLLAMA_BASE_URL`          | `http://localhost:11434`                                  | Ollama API endpoint                                                 |
| `OLLAMA_MODEL`             | `nomic-embed-text`                                        | Ollama model for embeddings                                         |
| `EMBEDDING_TIMEOUT_MS`     | `10000`                                                   | Timeout for embedding API calls                                     |
