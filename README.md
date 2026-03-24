# Agentic Brain

Long-term memory for AI agents. Agents read relevant memories at session start, write new insights during sessions, and team members can manually save context. Exposed as an MCP server — works with Claude Code, Cursor, and any MCP-compatible agent.

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
│               Agentic Brain MCP Server              │
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

| Field | Description |
|-------|-------------|
| `title` | Short label for display |
| `content` | The actual knowledge |
| `type` | `fact` · `decision` · `learning` · `pattern` · `preference` · `architecture` |
| `scope` | `project` (shared) or `user` (private to you) |
| `tags` | Free-form labels |
| `author` | Who created it |
| `source` | `manual` · `agent-auto` · etc. |
| `embedding` | 512-dim vector for semantic search |

---

## Quickstart

### Prerequisites

- Node.js 22+
- Docker (for local Postgres)
- AWS credentials with Bedrock access (for production embeddings; mock works locally without AWS)

### 1. Install

```bash
git clone https://github.com/feigi/agent-brain.git
cd agent-brain
npm install
```

### 2. Configure

Copy and edit the environment file:

```bash
cp .env.example .env
```

Key variables:

```env
# Database (defaults work with docker compose)
DATABASE_URL=postgresql://agentic:agentic@localhost:5432/agentic_brain

# Embedding provider: "ollama" for local dev, "titan" for production
EMBEDDING_PROVIDER=ollama

# AWS (required when EMBEDDING_PROVIDER=titan)
AWS_REGION=us-east-1
```

### 3. Start

**Local development (everything runs locally via Docker — no AWS needed):**

```bash
npm run dev
```

This starts Postgres + Ollama via Docker Compose (downloading `nomic-embed-text` on first run — ~274MB), runs database migrations, and starts the MCP server on stdio. No cloud credentials required.

**Minimal local setup (mock embeddings — fastest, no Ollama download):**

```bash
docker compose up -d --wait        # Start Postgres only
npx drizzle-kit migrate             # Run migrations
EMBEDDING_PROVIDER=mock npm start   # Start with mock embeddings
```

Mock mode uses random vectors — search results won't be semantically meaningful, but all tools work. Good for testing the MCP integration.

### 4. Connect to Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "agentic-brain": {
      "command": "npx",
      "args": ["tsx", "/path/to/agent-brain/src/server.ts"],
      "env": {
        "DATABASE_URL": "postgresql://agentic:agentic@localhost:5432/agentic_brain",
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_DIMENSIONS": "768"
      }
    }
  }
}
```

For production with Titan embeddings, set `EMBEDDING_PROVIDER=titan` and ensure `AWS_REGION` and credentials are available.

### 5. Integrate with Claude Code (optional)

Two optional enhancements that make Claude Code work better with Agentic Brain.

#### Add instructions to your CLAUDE.md

Create or edit `CLAUDE.md` in your project root (or `~/.claude/CLAUDE.md` for global) and paste this snippet. It tells Claude Code when and how to use the memory tools:

````markdown
## Agent Memory

This project uses [Agentic Brain](https://github.com/feigi/agent-brain) for shared team knowledge.

### Available Tools

- **memory_search** -- Search for relevant memories. Call with a query describing what you need.
- **memory_create** -- Save a new memory from important context the user shares.
- **memory_get** -- Read a specific memory by ID.
- **memory_update** -- Modify an existing memory.
- **memory_comment** -- Append a comment to an existing memory (turns it into a thread).
- **memory_verify** -- Confirm a memory is still accurate (updates verified_at).
- **memory_archive** -- Archive a memory that is no longer relevant.
- **memory_list_stale** -- List memories that need review (old or unverified).

### When to Call `memory_search`

**Call `memory_search` before actions that affect shared systems.** This includes:
1. **The user asks about notes, context, or team knowledge** -- e.g. "any notes?", "what should I know?"
2. **Before actions that affect shared infrastructure** -- deploys, database migrations, credential rotation, etc.
3. **Before running shared/integration tests** (e.g. E2E, load tests) -- but NOT local unit tests or builds

**Do NOT search for purely local actions** like editing files, installing dependencies, running local builds, linting, or formatting.

### When the User Shares Important Context

If the user mentions decisions, temporary changes, or gotchas that the team should know about, suggest saving a memory with `memory_create`. Always confirm before saving.

### Presenting Memories

Always **number** memories and include **author**, **date**, and **title**. The user may refer to memories by number (e.g. "archive memory 2", "comment on 1").
````

#### Add a session-review hook (optional)

A Stop hook can remind Claude to review and save learnings before ending a session.

**Prerequisites:** `jq` installed (`brew install jq` on macOS).

**Step 1:** Copy the hook script:

```bash
mkdir -p .claude/hooks
cp docs/hooks/memory-session-review.sh .claude/hooks/
chmod +x .claude/hooks/memory-session-review.sh
```

**Step 2:** Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-session-review.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

When Claude is about to stop, the hook blocks the first attempt and asks Claude to reflect on the session and save key learnings. See `docs/hooks/README.md` for details.

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

| Tool | Purpose |
|------|---------|
| `memory_session_start` | Load relevant memories at session start (call this first) |
| `memory_search` | Semantic search within a project |
| `memory_create` | Save a new memory |
| `memory_get` | Fetch a specific memory by ID |
| `memory_update` | Edit an existing memory |
| `memory_verify` | Mark a memory as still accurate |
| `memory_comment` | Add a threaded comment to a memory |
| `memory_archive` | Retire a memory that's no longer relevant |
| `memory_list` | List memories with filters |
| `memory_list_stale` | Find memories that need review |
| `memory_list_recent` | Most recently created/updated memories |

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

| Layer | Technology |
|-------|-----------|
| MCP server | `@modelcontextprotocol/sdk` (stdio transport) |
| Language | TypeScript 5.9 + Node.js 22 LTS |
| Database | PostgreSQL 17 + pgvector 0.8 (HNSW) |
| ORM | Drizzle ORM 0.45 |
| Embeddings | Amazon Titan Text V2 (512d, $0.02/1M tokens) |
| Validation | Zod 4 |
| Tests | Vitest 4 |

---

## Configuration reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://agentic:agentic@localhost:5432/agentic_brain` | Postgres connection string |
| `EMBEDDING_PROVIDER` | `mock` | `mock`, `ollama`, or `titan` |
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock |
| `WRITE_BUDGET_PER_SESSION` | `10` | Max memories an agent can create per session |
| `DUPLICATE_THRESHOLD` | `0.90` | Cosine similarity above which a new memory is rejected as duplicate |
| `RECENCY_HALF_LIFE_DAYS` | `14` | Half-life for recency score decay in search ranking |
| `EMBEDDING_DIMENSIONS` | `512` | Vector dimensions (512 for Titan, 768 for nomic-embed-text) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `nomic-embed-text` | Ollama model for embeddings |
| `EMBEDDING_TIMEOUT_MS` | `10000` | Timeout for embedding API calls |
