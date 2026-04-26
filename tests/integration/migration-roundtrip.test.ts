/**
 * E2E roundtrip integration test: pg → vault → pg
 *
 * Covers Phase 6 parity contract:
 *   1. Seed pg with 3 workspaces, 6 memories, 3 comments
 *   2. Run pg-to-vault (programmatically via runPgToVault)
 *   3. Re-open vault (close + reopen) to confirm persistence
 *   4. Sample findById reads for first 3 memory IDs
 *   5. Truncate pg
 *   6. Run vault-to-pg (programmatically via runVaultToPg)
 *   7. Assert counts match original
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema.js";
import { VaultBackend } from "../../src/backend/vault/index.js";
import { PostgresBackend } from "../../src/backend/postgres/index.js";
import {
  listMarkdownFiles,
  readMarkdown,
} from "../../src/backend/vault/io/vault-fs.js";
import { parseMemoryFile } from "../../src/backend/vault/parser/memory-parser.js";
import {
  runPgToVault,
  type PgSource,
} from "../../src/cli/migrate/pg-to-vault.js";
import {
  runVaultToPg,
  type VaultSource,
} from "../../src/cli/migrate/vault-to-pg.js";
import type { Memory } from "../../src/types/memory.js";
import type { Flag } from "../../src/types/flag.js";
import type { Relationship } from "../../src/types/relationship.js";
import { config } from "../../src/config.js";
import { TEST_DB_URL } from "../global-setup.js";

// Stub embedding: uses the configured dimensions so it matches the pg vector column.
// The test DB is created via global-setup using the same drizzle migrations, which
// use config.embeddingDimensions for the vector(N) column size.
const DIMS = config.embeddingDimensions;
const STUB_EMBEDDING = new Array<number>(DIMS).fill(0.1);
const stubEmbedder = async () => STUB_EMBEDDING;

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-01T00:00:00.000Z");
const PROJECT_ID = "test-migration-roundtrip";

const WORKSPACES = [
  { id: "ws-a", created_at: NOW },
  { id: "ws-b", created_at: NOW },
  { id: "ws-c", created_at: NOW },
];

// 6 memories: 2 per workspace
const MEMORIES: Array<Memory & { embedding: number[] }> = [
  {
    id: "mem-a1",
    project_id: PROJECT_ID,
    workspace_id: "ws-a",
    content: "Memory A1 content",
    title: "Memory A1",
    type: "fact",
    scope: "workspace" as const,
    tags: ["tagA"],
    author: "alice",
    source: "manual" as const,
    session_id: null,
    metadata: null,
    embedding_model: "stub",
    embedding_dimensions: DIMS,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    embedding: STUB_EMBEDDING,
  } as never,
  {
    id: "mem-a2",
    project_id: PROJECT_ID,
    workspace_id: "ws-a",
    content: "Memory A2 content",
    title: "Memory A2",
    type: "decision",
    scope: "workspace" as const,
    tags: null,
    author: "alice",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: "stub",
    embedding_dimensions: DIMS,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    embedding: STUB_EMBEDDING,
  } as never,
  {
    id: "mem-b1",
    project_id: PROJECT_ID,
    workspace_id: "ws-b",
    content: "Memory B1 content",
    title: "Memory B1",
    type: "learning",
    scope: "workspace" as const,
    tags: ["tagB"],
    author: "bob",
    source: "agent-auto" as const,
    session_id: "sess-1",
    metadata: { key: "val" },
    embedding_model: "stub",
    embedding_dimensions: DIMS,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    embedding: STUB_EMBEDDING,
  } as never,
  {
    id: "mem-b2",
    project_id: PROJECT_ID,
    workspace_id: "ws-b",
    content: "Memory B2 content",
    title: "Memory B2",
    type: "pattern",
    scope: "workspace" as const,
    tags: null,
    author: "bob",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: "stub",
    embedding_dimensions: DIMS,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    embedding: STUB_EMBEDDING,
  } as never,
  {
    id: "mem-c1",
    project_id: PROJECT_ID,
    workspace_id: "ws-c",
    content: "Memory C1 content",
    title: "Memory C1",
    type: "preference",
    scope: "workspace" as const,
    tags: null,
    author: "carol",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: "stub",
    embedding_dimensions: DIMS,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    embedding: STUB_EMBEDDING,
  } as never,
  {
    id: "mem-c2",
    project_id: PROJECT_ID,
    workspace_id: "ws-c",
    content: "Memory C2 content",
    title: "Memory C2",
    type: "architecture",
    scope: "workspace" as const,
    tags: ["tagC"],
    author: "carol",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: "stub",
    embedding_dimensions: DIMS,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    embedding: STUB_EMBEDDING,
  } as never,
];

// 3 comments: one on each of the first 3 memories
const COMMENTS = [
  {
    id: "cmt-1",
    memory_id: "mem-a1",
    author: "alice",
    content: "Comment on A1",
  },
  { id: "cmt-2", memory_id: "mem-a2", author: "bob", content: "Comment on A2" },
  {
    id: "cmt-3",
    memory_id: "mem-b1",
    author: "carol",
    content: "Comment on B1",
  },
];

// Source counts (what we seed into pg)
const SEED_COUNTS = {
  workspaces: 3,
  memories: 6,
  comments: 3,
  flags: 0,
  relationships: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedPg(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<void> {
  // Insert workspaces
  for (const ws of WORKSPACES) {
    await db
      .insert(schema.workspaces)
      .values({ id: ws.id, created_at: ws.created_at })
      .onConflictDoNothing();
  }

  // Insert memories (without the computed counts — those are not db columns)
  for (const mem of MEMORIES) {
    await db
      .insert(schema.memories)
      .values({
        id: mem.id,
        project_id: mem.project_id,
        workspace_id: mem.workspace_id,
        content: mem.content,
        title: mem.title,
        type: mem.type,
        scope: mem.scope,
        tags: mem.tags ?? undefined,
        author: mem.author,
        source: mem.source ?? undefined,
        session_id: mem.session_id ?? undefined,
        metadata: mem.metadata ?? undefined,
        embedding_model: mem.embedding_model ?? undefined,
        embedding_dimensions: mem.embedding_dimensions ?? undefined,
        version: mem.version,
        created_at: mem.created_at,
        updated_at: mem.updated_at,
        verified_at: mem.verified_at ?? undefined,
        archived_at: mem.archived_at ?? undefined,
        verified_by: mem.verified_by ?? undefined,
        last_comment_at: mem.last_comment_at ?? undefined,
      } as never)
      .onConflictDoNothing();
  }

  // Insert comments
  for (const cmt of COMMENTS) {
    await db
      .insert(schema.comments)
      .values({
        id: cmt.id,
        memory_id: cmt.memory_id,
        author: cmt.author,
        content: cmt.content,
      })
      .onConflictDoNothing();
  }
}

async function readCountsFromPg(
  client: ReturnType<typeof postgres>,
): Promise<typeof SEED_COUNTS> {
  const [[w], [m], [c], [f], [r]] = await Promise.all([
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM workspaces`,
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM memories`,
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM comments`,
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM flags`,
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM relationships`,
  ]);
  return {
    workspaces: w.n,
    memories: m.n,
    comments: c.n,
    flags: f.n,
    relationships: r.n,
  };
}

async function buildVaultSourceFromDisk(
  root: string,
  vault: VaultBackend,
): Promise<VaultSource> {
  const relPaths = await listMarkdownFiles(root);

  const memoryRows: Array<{ memory: Memory; embedding: number[] }> = [];
  const commentRows: Array<{
    id: string;
    memory_id: string;
    author: string;
    content: string;
  }> = [];
  const flagRows: Flag[] = [];
  const relationshipRows: Relationship[] = [];

  for (const relPath of relPaths) {
    let md: string;
    try {
      md = await readMarkdown(root, relPath);
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parseMemoryFile(md);
    } catch {
      continue;
    }

    const vecRow = await vault.lookupVector(parsed.memory.id);
    memoryRows.push({
      memory: parsed.memory,
      embedding: vecRow?.embedding ?? [],
    });
    for (const c of parsed.comments) {
      commentRows.push({
        id: c.id,
        memory_id: c.memory_id,
        author: c.author,
        content: c.content,
      });
    }
    for (const f of parsed.flags) flagRows.push(f);
    for (const r of parsed.relationships) relationshipRows.push(r);
  }

  const wsEntries = await readdir(`${root}/workspaces`, {
    withFileTypes: true,
  }).catch(() => []);
  const workspaces = wsEntries
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, created_at: new Date() }));

  const counts = {
    workspaces: workspaces.length,
    memories: memoryRows.length,
    comments: commentRows.length,
    flags: flagRows.length,
    relationships: relationshipRows.length,
  };

  return {
    readWorkspaces: async () => workspaces,
    readMemoriesWithEmbeddings: async () => memoryRows,
    readComments: async () => commentRows,
    readFlags: async () => flagRows,
    readRelationships: async () => relationshipRows,
    counts: async () => counts,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe(
  "migration E2E roundtrip: pg → vault → pg",
  { timeout: 60_000 },
  () => {
    let vaultRoot: string;
    let client: ReturnType<typeof postgres>;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    beforeAll(async () => {
      // Set up temp vault directory
      vaultRoot = await mkdtemp(join(tmpdir(), "ab-migration-roundtrip-"));

      // Connect to pg test DB
      client = postgres(TEST_DB_URL, { onnotice: () => {} });
      db = drizzle(client, { schema });

      // Clean slate — truncate all tables before seeding
      await client`
      TRUNCATE TABLE relationships, flags, comments, memories, workspaces
      RESTART IDENTITY CASCADE
    `;

      // Seed pg with fixture data
      await seedPg(db);
    });

    afterAll(async () => {
      // Truncate the pg tables we used, to avoid polluting other tests
      await client`
      TRUNCATE TABLE relationships, flags, comments, memories, workspaces
      RESTART IDENTITY CASCADE
    `.catch(() => {});
      await client.end().catch(() => {});
      await rm(vaultRoot, { recursive: true, force: true }).catch(() => {});
    });

    it("phase 1: seeds pg with expected counts", async () => {
      const counts = await readCountsFromPg(client);
      expect(counts.workspaces).toBe(SEED_COUNTS.workspaces);
      expect(counts.memories).toBe(SEED_COUNTS.memories);
      expect(counts.comments).toBe(SEED_COUNTS.comments);
      expect(counts.flags).toBe(SEED_COUNTS.flags);
      expect(counts.relationships).toBe(SEED_COUNTS.relationships);
    });

    it("phase 2: pg-to-vault migration writes all data", async () => {
      // Build PgSource from the seeded pg data
      const source: PgSource = {
        readWorkspaces: () =>
          db
            .select()
            .from(schema.workspaces)
            .then((rows) =>
              rows.map((w) => ({ id: w.id, created_at: w.created_at })),
            ),
        readMemoriesWithEmbeddings: async () => {
          const rows = await db.select().from(schema.memories);
          return rows.map((r) => ({
            memory: {
              id: r.id,
              project_id: r.project_id,
              workspace_id: r.workspace_id ?? null,
              content: r.content,
              title: r.title,
              type: r.type,
              scope: r.scope,
              tags: r.tags ?? null,
              author: r.author,
              source: r.source ?? null,
              session_id: r.session_id ?? null,
              metadata: (r.metadata as Record<string, unknown> | null) ?? null,
              embedding_model: r.embedding_model ?? null,
              embedding_dimensions: r.embedding_dimensions ?? null,
              version: r.version,
              created_at: r.created_at,
              updated_at: r.updated_at,
              verified_at: r.verified_at ?? null,
              archived_at: r.archived_at ?? null,
              verified_by: r.verified_by ?? null,
              last_comment_at: r.last_comment_at ?? null,
              comment_count: 0,
              flag_count: 0,
              relationship_count: 0,
            } satisfies Memory,
            embedding: STUB_EMBEDDING, // carry-over stub embedding
          }));
        },
        readComments: () =>
          db
            .select()
            .from(schema.comments)
            .then((rows) =>
              rows.map((c) => ({
                id: c.id,
                memory_id: c.memory_id,
                author: c.author,
                content: c.content,
              })),
            ),
        readFlags: async () => [],
        readRelationships: async () => [],
        counts: async () => SEED_COUNTS,
      };

      // Create vault backend in migration mode
      const vault1 = await VaultBackend.create({
        root: vaultRoot,
        projectId: PROJECT_ID,
        embeddingDimensions: DIMS,
        migrationMode: true,
      });

      try {
        await runPgToVault({
          source,
          destination: vault1,
          reembed: false,
          embedder: stubEmbedder,
        });
      } finally {
        await vault1.close();
      }

      // Vault1 is now closed. Re-open to confirm persistence.
      const vault2 = await VaultBackend.create({
        root: vaultRoot,
        projectId: PROJECT_ID,
        embeddingDimensions: DIMS,
        migrationMode: true,
      });

      try {
        // Sample findById for first 3 memory IDs — must all be non-null and match
        for (const id of ["mem-a1", "mem-a2", "mem-b1"]) {
          const found = await vault2.memoryRepo.findById(id);
          expect(
            found,
            `findById(${id}) should return non-null after pg-to-vault`,
          ).not.toBeNull();
          expect(found!.id).toBe(id);
        }
      } finally {
        await vault2.close();
      }
    });

    it("phase 3: vault-to-pg restores all data to a fresh pg", async () => {
      // Truncate pg tables — simulate fresh target
      await client`
      TRUNCATE TABLE relationships, flags, comments, memories, workspaces
      RESTART IDENTITY CASCADE
    `;

      // Confirm pg is empty
      const before = await readCountsFromPg(client);
      expect(before.memories).toBe(0);
      expect(before.workspaces).toBe(0);

      // Open vault in migration mode to read from it
      const vault3 = await VaultBackend.create({
        root: vaultRoot,
        projectId: PROJECT_ID,
        embeddingDimensions: DIMS,
        migrationMode: true,
      });

      let vSource: VaultSource;
      try {
        vSource = await buildVaultSourceFromDisk(vaultRoot, vault3);
      } finally {
        await vault3.close();
      }

      // Open a fresh PostgresBackend (pg2 = destination)
      const pg2 = await PostgresBackend.create(TEST_DB_URL);
      try {
        await runVaultToPg({
          source: vSource,
          destination: pg2,
          reembed: false,
          embedder: stubEmbedder,
        });
      } finally {
        await pg2.close();
      }

      // Assert counts match original seed
      const after = await readCountsFromPg(client);
      expect(after.memories, "memory count after vault-to-pg").toBe(
        SEED_COUNTS.memories,
      );
      expect(after.workspaces, "workspace count after vault-to-pg").toBe(
        SEED_COUNTS.workspaces,
      );
      expect(after.comments, "comment count after vault-to-pg").toBe(
        SEED_COUNTS.comments,
      );
      expect(after.flags, "flag count after vault-to-pg").toBe(
        SEED_COUNTS.flags,
      );
      expect(after.relationships, "relationship count after vault-to-pg").toBe(
        SEED_COUNTS.relationships,
      );
    });
  },
);
