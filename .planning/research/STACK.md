# Stack Research

**Domain:** AI Agent Long-Term Memory System (MCP Server)
**Researched:** 2026-03-23
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| TypeScript | 5.9.x (stable) | Language | Type safety is non-negotiable for a system where schema changes break agents. TS 5.9 is the current stable release. Do NOT use the 6.0 RC in production -- it is the last JS-based compiler before the Go rewrite and still in RC. |
| Node.js | 22.x LTS | Runtime | Current LTS with native TypeScript stripping support, `require(ESM)`, and built-in test runner. Node 22 entered LTS Oct 2024, supported through Apr 2027. |
| @modelcontextprotocol/sdk | ^1.27.x | MCP server framework | The official TypeScript SDK for MCP. Defines tools, resources, and prompts with Zod schemas. Supports stdio and Streamable HTTP transports. Use the official SDK directly -- it is the foundation all frameworks build on and gives maximum control over the protocol. |
| PostgreSQL | 16.x or 17.x | Primary database | Single database for relational data (users, projects, sessions) AND vector data (embeddings). RDS-managed, battle-tested, the team already knows it. PostgreSQL 17.1+ supports pgvector 0.8.x on RDS. |
| pgvector | 0.8.x | Vector similarity search | Postgres extension for storing and querying embeddings. v0.8.0 added iterative index scans (fixes filtered search accuracy issues) and up to 5.7x query performance improvement. Supported on RDS PostgreSQL 17.1+ and Aurora. |
| Amazon Titan Text Embeddings V2 | amazon.titan-embed-text-v2:0 | Embedding generation | Model ID: `amazon.titan-embed-text-v2:0`. 8,192 token input, configurable output dimensions (256/512/1024). $0.02/1M tokens. Same AWS ecosystem as RDS. Outputs unit-normalized vectors optimized for cosine similarity. Use 512 dimensions -- retains 99% accuracy of 1024 at half the storage. |
| Drizzle ORM | 0.45.x (stable) | Database ORM / query builder | Type-safe SQL with first-class pgvector support (`vector()` column type, `cosineDistance()`, `l2Distance()`, HNSW index definitions). Thin abstraction -- generates predictable SQL. Supports migrations via drizzle-kit. Do NOT use the 1.0 beta in production -- it has breaking migration changes. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | ^4.3.x | Schema validation | Required by MCP SDK for tool input schemas. Also used for validating memory payloads, config, and API boundaries. MCP SDK 1.27.x uses zod v4 internally and declares zod as a peer dependency supporting both v3.25+ and v4. Use zod 4.x for new projects. |
| @aws-sdk/client-bedrock-runtime | ^3.1014.x | Bedrock API client | Invoke Titan embeddings via `InvokeModelCommand`. AWS SDK v3 is modular -- install only the client you need, not the entire SDK. Uses default credential provider chain (env vars, IAM roles, SSO). |
| pgvector (npm) | ^0.2.1 | Vector type helpers for Node.js | Provides `toSql()` for converting JS arrays to pgvector format and `registerTypes()` for the pg driver. Works with Drizzle ORM via `pgvector/drizzle` import. |
| postgres (postgres.js) | ^3.4.8 | PostgreSQL driver | Fastest pure-JS Postgres driver. Tagged template SQL, automatic prepared statements, TypeScript types. Drizzle ORM's recommended driver for Postgres. Prefer over `pg` (node-postgres) for new projects. |
| tsx | ^4.21.x | TypeScript execution | Run TypeScript files directly without build step. Used for development (`tsx watch`), scripts, and MCP server stdio entry point (`npx tsx server.ts`). Faster than `ts-node`. |
| dotenv | ^16.x | Environment config | Load `.env` files for local development (DB connection strings, AWS region). Not needed in production where env vars come from infrastructure. |
| nanoid | ^5.x | ID generation | URL-safe unique IDs for memories, sessions, projects. Smaller and faster than UUID. Use `nanoid(21)` for 21-char IDs with ~148 bits of entropy. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| drizzle-kit | 0.31.x (stable) | Database migrations | Generates SQL migration files from schema changes. Run `drizzle-kit generate` then `drizzle-kit migrate`. Do NOT use the 1.0 beta -- stick with 0.31.x stable which pairs with drizzle-orm 0.45.x. |
| vitest | ^4.1.x | Testing framework | Fast, TypeScript-native, ESM-first. Use for unit tests (embedding logic, memory scoring) and integration tests (database queries). Built-in mocking, coverage, and watch mode. |
| @modelcontextprotocol/inspector | latest | MCP debugging | Visual inspector for testing MCP servers during development. Connect to your server and invoke tools interactively. Essential for debugging tool schemas and responses. |
| eslint + @typescript-eslint | ^9.x | Linting | Flat config format. Catches type errors and enforces consistency. |
| prettier | ^3.x | Formatting | Consistent code style. End of discussion. |
| docker-compose | latest | Local Postgres | Run `pgvector/pgvector:pg17` locally. Matches RDS setup. Avoids "works on my machine" issues. |

## Installation

```bash
# Core runtime
npm install @modelcontextprotocol/sdk zod @aws-sdk/client-bedrock-runtime drizzle-orm postgres pgvector nanoid dotenv

# Dev dependencies
npm install -D typescript@~5.9.3 tsx drizzle-kit@~0.31.10 vitest @types/node eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser prettier @modelcontextprotocol/inspector
```

## Key Configuration

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

### Drizzle schema with pgvector

```typescript
import { pgTable, text, timestamp, vector, index, serial } from 'drizzle-orm/pg-core';

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(), // nanoid
    content: text('content').notNull(),
    projectId: text('project_id').notNull(),
    userId: text('user_id'),
    embedding: vector('embedding', { dimensions: 512 }), // Titan V2 @ 512d
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('memories_embedding_idx')
      .using('hnsw', table.embedding.op('vector_cosine_ops')),
  ]
);
```

### Titan V2 embedding call

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await bedrock.send(new InvokeModelCommand({
    modelId: 'amazon.titan-embed-text-v2:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      inputText: text,
      dimensions: 512,      // 99% accuracy of 1024, half the storage
      normalize: true,       // unit vector for cosine similarity
    }),
  }));
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.embedding;
}
```

### MCP server entry point

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'agent-brain',
  version: '0.1.0',
});

server.tool(
  'save_note',
  'Save a memory note for the current project',
  { content: z.string(), title: z.string().optional() },
  async ({ content, title }) => {
    // Implementation here
    return { content: [{ type: 'text', text: 'Saved.' }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// IMPORTANT: Never use console.log() in stdio servers -- it corrupts JSON-RPC.
// Use console.error() for debug output (writes to stderr).
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Official MCP SDK | FastMCP | If you want less boilerplate and don't need protocol-level control. FastMCP wraps the official SDK with convenience APIs. Risk: it is a third-party wrapper that must track upstream changes. For a memory system that IS the MCP server (not a server calling others), use the official SDK. |
| Drizzle ORM | Prisma | Never for this project. Prisma has no native pgvector support, generates a query engine binary, and adds latency. Drizzle generates plain SQL and has built-in `vector()`, `cosineDistance()`, and HNSW index support. |
| Drizzle ORM | Raw SQL (postgres.js) | If Drizzle adds friction for complex vector queries. You can always drop to `sql` tagged templates within Drizzle for escape hatches. Start with Drizzle, use raw SQL only when the ORM gets in the way. |
| postgres.js | node-postgres (pg) | If you need native C bindings for maximum throughput (`pg-native`). In practice, postgres.js is faster for typical workloads due to automatic prepared statement caching. The pgvector npm package supports both drivers. |
| Amazon Titan V2 | OpenAI text-embedding-3-small | If you leave AWS or need multilingual embeddings that Titan handles poorly. OpenAI's model is better benchmarked but costs more ($0.02/1M tokens for Titan vs $0.02/1M for OpenAI small -- comparable, but Titan avoids a second vendor). The embedding provider is abstracted behind an interface, so swapping is a config change. |
| Amazon Titan V2 | Cohere embed-v4 | If you need retrieval-optimized embeddings with built-in search/document type hints. More expensive. Abstract the provider so this becomes a future option. |
| pgvector (Postgres) | Pinecone / Qdrant / Weaviate | If you need to scale beyond what a single Postgres instance handles (millions of vectors with sub-10ms p99). For a team memory system with thousands to tens of thousands of memories, pgvector in Postgres is more than sufficient and avoids a separate service. |
| Vitest | Jest | Never for a new TypeScript project in 2026. Vitest is faster, ESM-native, and TypeScript-native without transform hacks. Jest 30 improved but Vitest has won the ecosystem. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| LangChain.js | Massive dependency tree, abstracts too much, locks you into their patterns. For a focused memory system, you don't need an "AI framework" -- you need an embedding call and a vector query. | Direct AWS SDK calls for embeddings, Drizzle for vector queries. Two dependencies instead of dozens. |
| Prisma | No native pgvector support. Requires raw SQL for all vector operations, defeating the purpose of an ORM. Also: query engine binary, cold start overhead, schema drift issues. | Drizzle ORM with built-in pgvector column types and distance functions. |
| drizzle-orm 1.0 beta / drizzle-kit 1.0 beta | Active development, breaking migration changes, not stable. Multiple beta releases per day as of March 2026. | drizzle-orm 0.45.x + drizzle-kit 0.31.x (stable pairing). |
| TypeScript 6.0 RC | Release candidate, not stable. Also the last JS-based compiler -- TypeScript 7 is being rewritten in Go. Stick with stable. | TypeScript 5.9.x. |
| Dedicated vector databases (Pinecone, Weaviate, Qdrant) | Adds operational complexity for a system that will have thousands, not millions, of vectors. pgvector in the same Postgres instance means one database to manage, backup, and query. | pgvector extension in PostgreSQL. |
| Mem0 (as a dependency) | Mem0 is a full framework with its own opinions about memory extraction, graph storage, and LLM-powered fact extraction. We need a focused MCP server, not a framework. Study Mem0's architecture for patterns, but don't depend on it. | Custom implementation using the stack above. Borrow Mem0's dual-storage pattern (vector + relational) and fact extraction concepts. |
| console.log in MCP stdio servers | Writes to stdout, corrupts JSON-RPC message framing, breaks the server silently. | console.error() for debug output (writes to stderr). |

## Stack Patterns by Variant

**If deploying as stdio server (Claude Code, Cursor):**
- Use `StdioServerTransport` from MCP SDK
- Entry point: `npx tsx src/server.ts` (configured in client's MCP settings)
- All logging to stderr via `console.error()`
- Database connection string from environment variables

**If deploying as HTTP server (remote/team access):**
- Use `StreamableHTTPServerTransport` with Express or Hono
- Add OAuth 2.1 / bearer token authentication
- For internal team use, static bearer tokens are pragmatic and sufficient
- Enable CORS and DNS rebinding protection via `createMcpExpressApp()`

**If swapping embedding provider:**
- Abstract behind an `EmbeddingProvider` interface: `embed(text: string): Promise<number[]>`
- Configure via environment variable (e.g., `EMBEDDING_PROVIDER=titan|openai`)
- All providers must output the same dimensionality (512) or re-index is required
- Store provider name + dimension in a metadata table for migration safety

**If scaling beyond single Postgres:**
- First: add read replicas for search queries (RDS supports this natively)
- Then: consider partitioning memories table by project_id
- Last resort: move vector search to a dedicated service (Qdrant) while keeping relational data in Postgres
- This won't be needed until 100K+ memories with complex filtered searches

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| drizzle-orm@0.45.x | drizzle-kit@0.31.x | Must use matching stable versions. Do NOT mix stable ORM with beta kit or vice versa. |
| drizzle-orm@0.45.x | postgres@3.4.x | Drizzle's recommended Postgres driver pairing. Import via `drizzle-orm/postgres-js`. |
| pgvector@0.2.1 (npm) | drizzle-orm@0.45.x | Use `import pgvector from 'pgvector/drizzle'` for type conversions alongside Drizzle's built-in `vector()` column. |
| pgvector@0.2.1 (npm) | postgres@3.4.x | Works via `pgvector/postgres` import path. |
| pgvector 0.8.x (extension) | PostgreSQL 17.1+ on RDS | Requires PG 17.1+ on RDS. Also available on PG 16.5+, 15.9+. |
| @modelcontextprotocol/sdk@1.27.x | zod@3.25+ or zod@4.x | SDK uses zod v4 internally but declares zod as a peer dep supporting both v3.25+ and v4.x. Use zod 4.x for new projects -- no compatibility issue. |
| @aws-sdk/client-bedrock-runtime@3.x | Node.js 18+ | AWS SDK v3 requires Node.js 18 or later. Node 22 LTS is well within support. |
| TypeScript@5.9.x | Node.js 22.x | Full compatibility. Module resolution: `nodenext`. |

### Zod Version Note

The MCP SDK 1.27.x has been updated to use Zod v4 internally and accepts both Zod v3.25+ and Zod v4.x as a peer dependency. For new projects, use Zod 4.x directly. If you have existing code using Zod 3.x APIs, you can import from `zod/v3` for backward compatibility while the SDK uses `zod/v4` internally. This is a resolved concern -- no version conflict.

## Embedding Dimension Strategy

| Dimension | Storage per Vector | Accuracy vs 1024 | Recommendation |
|-----------|-------------------|-------------------|----------------|
| 256 | 1 KB | 97% | Only for extremely high volume (1M+ memories). |
| 512 | 2 KB | 99% | **Use this.** Best balance of accuracy, storage, and index performance. |
| 1024 | 4 KB | 100% (baseline) | Overkill for memory snippets. Doubles storage and slows HNSW index builds. |

Use 512 dimensions. The 1% accuracy loss is undetectable in practice for text memories, and HNSW index performance scales with dimensionality.

## HNSW Index Tuning

For a memory system with < 100K vectors:

```sql
CREATE INDEX memories_embedding_idx ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

- `m = 16`: Default. Connections per node. Higher = better recall, more memory.
- `ef_construction = 64`: Default. Build-time search width. Higher = better index quality, slower builds.
- At search time, set `SET hnsw.ef_search = 40` (default). Increase to 100+ only if recall is insufficient.

Do NOT create the index until you have data. Building HNSW on an empty table is pointless and the index quality is better when built on existing data.

## Docker Compose for Local Development

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: agent_brain
      POSTGRES_USER: agent_brain
      POSTGRES_PASSWORD: local_dev_only
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

The `pgvector/pgvector:pg17` image includes PostgreSQL 17 with pgvector pre-installed. No manual extension installation needed.

## Sources

- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) -- SDK architecture, transport options, tool definitions (HIGH confidence)
- [MCP TypeScript SDK server docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) -- Server building patterns, Express/Hono integration (HIGH confidence)
- [MCP SDK npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- Version 1.27.1, latest stable (HIGH confidence)
- [MCP SDK + Zod 4 compatibility](https://github.com/modelcontextprotocol/typescript-sdk/issues/555) -- SDK supports both zod v3.25+ and v4 as peer dep (HIGH confidence)
- [pgvector GitHub](https://github.com/pgvector/pgvector) -- Extension features, HNSW/IVFFlat indexes, v0.8.x changelog (HIGH confidence)
- [pgvector-node GitHub](https://github.com/pgvector/pgvector-node) -- Node.js/Drizzle/pg integration, v0.2.1 (HIGH confidence)
- [AWS Titan Text Embeddings V2 docs](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html) -- Model ID, dimensions, token limits (HIGH confidence)
- [AWS Titan V2 blog post](https://aws.amazon.com/blogs/machine-learning/get-started-with-amazon-titan-text-embeddings-v2-a-new-state-of-the-art-embeddings-model-on-amazon-bedrock/) -- Dimension accuracy tradeoffs, normalization (HIGH confidence)
- [Drizzle ORM pgvector guide](https://orm.drizzle.team/docs/guides/vector-similarity-search) -- Vector columns, cosineDistance, HNSW index definitions (HIGH confidence)
- [AWS RDS pgvector support](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-rds-for-postgresql-pgvector-080/) -- pgvector 0.8.0 on RDS PG 17.1+ (HIGH confidence)
- [MCP Authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) -- OAuth 2.1, bearer tokens for team servers (MEDIUM confidence -- spec evolving)
- [Mem0 architecture paper](https://arxiv.org/abs/2504.19413) -- Memory extraction patterns, dual storage design (MEDIUM confidence -- informational, not a dependency)
- [postgres.js GitHub](https://github.com/porsager/postgres) -- Driver features, v3.4.8, benchmark data (HIGH confidence)
- [pgvector 2026 guide](https://www.instaclustr.com/education/vector-database/pgvector-key-features-tutorial-and-pros-and-cons-2026-guide/) -- HNSW tuning, scaling patterns (MEDIUM confidence)
- [MCP authentication blog](https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/) -- Auth patterns for team MCP servers (MEDIUM confidence)

---
*Stack research for: AI Agent Long-Term Memory System (MCP Server)*
*Researched: 2026-03-23*
