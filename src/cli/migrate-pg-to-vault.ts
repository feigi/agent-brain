#!/usr/bin/env node
import { simpleGit } from "simple-git";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { readdir } from "node:fs/promises";
import * as schema from "../db/schema.js";
import { VaultBackend } from "../backend/vault/index.js";
import {
  listMarkdownFiles,
  readMarkdown,
} from "../backend/vault/io/vault-fs.js";
import { parseMemoryFile } from "../backend/vault/parser/memory-parser.js";
import { createEmbeddingProvider } from "../providers/embedding/index.js";
import { checkDims } from "./migrate/preflight.js";
import { compareCounts } from "./migrate/verify.js";
import { runPgToVault, type PgSource } from "./migrate/pg-to-vault.js";
import { EXIT, type ExitCode, type CountsByKind } from "./migrate/types.js";
import type { Memory } from "../types/memory.js";
import type { Flag } from "../types/flag.js";
import type { Relationship } from "../types/relationship.js";

interface Args {
  vaultRoot: string;
  pgUrl: string;
  projectId: string;
  embeddingDimensions: number;
  reembed: boolean;
  verify: boolean;
  dryRun: boolean;
  trackUsersInGit: boolean;
  yes: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (k: string): boolean => argv.includes(k);
  const required = (envKey: string, flagKey: string): string => {
    const v = get(flagKey) ?? process.env[envKey];
    if (!v) {
      console.error(`missing ${flagKey} (or env ${envKey})`);
      process.exit(EXIT.PREFLIGHT);
    }
    return v;
  };
  const dimsRaw =
    get("--embedding-dimensions") ??
    process.env.AGENT_BRAIN_EMBEDDING_DIMENSIONS;
  if (!dimsRaw) {
    console.error(
      "missing --embedding-dimensions (or env AGENT_BRAIN_EMBEDDING_DIMENSIONS)",
    );
    process.exit(EXIT.PREFLIGHT);
  }
  const dims = Number.parseInt(dimsRaw, 10);
  if (!Number.isFinite(dims) || dims <= 0) {
    console.error(`invalid embedding dimensions: ${dimsRaw}`);
    process.exit(EXIT.PREFLIGHT);
  }
  return {
    vaultRoot: required("AGENT_BRAIN_VAULT_ROOT", "--vault-root"),
    pgUrl: required("AGENT_BRAIN_DATABASE_URL", "--pg-url"),
    projectId: required("AGENT_BRAIN_PROJECT_ID", "--project-id"),
    embeddingDimensions: dims,
    reembed: has("--reembed"),
    verify: !has("--no-verify"),
    dryRun: has("--dry-run"),
    trackUsersInGit: has("--track-users-in-git"),
    yes: has("--yes"),
  };
}

async function main(argv: readonly string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  console.log(
    `pg→vault migration:\n` +
      `  vault-root: ${args.vaultRoot}\n` +
      `  pg: ${args.pgUrl.replace(/:[^:@]*@/, ":***@")}\n` +
      `  project-id: ${args.projectId}\n` +
      `  embedding dims: ${args.embeddingDimensions}\n` +
      `  reembed: ${args.reembed}\n` +
      `  verify: ${args.verify}\n` +
      `  dry-run: ${args.dryRun}`,
  );
  if (!args.yes && !args.dryRun) {
    console.log("Starting in 3s — Ctrl-C to abort.");
    await new Promise((r) => setTimeout(r, 3000));
  }

  const client = postgres(args.pgUrl, { onnotice: () => {} });
  const db = drizzle(client, { schema });

  // Source dim from pgvector column metadata
  const dimRow = await client<Array<{ atttypmod: number }>>`
    SELECT atttypmod FROM pg_attribute
    WHERE attrelid = 'memories'::regclass AND attname = 'embedding'
  `;
  if (dimRow.length === 0) {
    console.error("could not introspect memories.embedding column dim");
    await client.end();
    return EXIT.PREFLIGHT;
  }
  const sourceDim = dimRow[0].atttypmod;

  const dimCheck = checkDims({
    sourceDim,
    destDim: args.embeddingDimensions,
    reembed: args.reembed,
  });
  if (!dimCheck.ok) {
    console.error(`preflight: ${dimCheck.reason}`);
    await client.end();
    return EXIT.PREFLIGHT;
  }

  const counts: CountsByKind = await readCounts(db);
  console.log(
    `source counts: workspaces=${counts.workspaces} memories=${counts.memories} ` +
      `comments=${counts.comments} flags=${counts.flags} relationships=${counts.relationships}`,
  );

  if (args.dryRun) {
    console.log("dry-run: exiting without writes.");
    await client.end();
    return EXIT.OK;
  }

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
        memory: rowToMemory(r),
        embedding: r.embedding ?? [],
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
    readFlags: () =>
      db
        .select()
        .from(schema.flags)
        .then((rows) => rows.map((f) => rowToFlag(f))),
    readRelationships: () =>
      db
        .select()
        .from(schema.relationships)
        .then((rows) => rows.map((r) => rowToRelationship(r))),
    counts: async () => counts,
  };

  const backend = await VaultBackend.create({
    root: args.vaultRoot,
    projectId: args.projectId,
    embeddingDimensions: args.embeddingDimensions,
    trackUsersInGit: args.trackUsersInGit,
    migrationMode: true,
  });

  const provider = createEmbeddingProvider();
  const embedder = (text: string): Promise<number[]> => provider.embed(text);

  try {
    await runPgToVault({
      source,
      destination: backend,
      reembed: args.reembed,
      embedder,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`write phase failed: ${msg}`);
    await backend.close();
    await client.end();
    return EXIT.WRITE;
  }

  await backend.close();

  // Single bulk commit
  try {
    const git = simpleGit({ baseDir: args.vaultRoot });
    if (!(await git.checkIsRepo())) {
      await git.init();
    }
    await git.add(["-A"]);
    const status = await git.status();
    if (status.staged.length > 0 || status.created.length > 0) {
      const actor =
        (
          await git.raw(["config", "user.email"]).catch(() => "agent-brain")
        ).trim() || "agent-brain";
      const subject = "migration: pg → vault";
      const body =
        `AB-Action: migration\n` +
        `AB-Source: pg\n` +
        `AB-Count: ${counts.memories}\n` +
        `AB-Actor: ${actor}`;
      await git.commit(`${subject}\n\n${body}`);
    } else {
      console.log("no files staged after migration — nothing to commit.");
    }

    const remotes = await git.getRemotes(true);
    if (remotes.some((r) => r.name === "origin")) {
      try {
        await git.raw(["push", "--set-upstream", "origin", "HEAD:main"]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`push failed (commit landed locally): ${msg}`);
        await client.end();
        return EXIT.COMMIT_OR_PUSH;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`bulk commit failed: ${msg}`);
    await client.end();
    return EXIT.COMMIT_OR_PUSH;
  }

  if (args.verify) {
    const destBackend = await VaultBackend.create({
      root: args.vaultRoot,
      projectId: args.projectId,
      embeddingDimensions: args.embeddingDimensions,
      trackUsersInGit: args.trackUsersInGit,
      migrationMode: true,
    });
    const destCounts = await readCountsFromVault(args.vaultRoot);
    await destBackend.close();
    const diff = compareCounts(counts, destCounts);
    if (diff.length > 0) {
      for (const d of diff) {
        console.error(
          `verify mismatch: ${d.kind} source=${d.source} destination=${d.destination}`,
        );
      }
      await client.end();
      return EXIT.VERIFY;
    }
    console.log("verify: counts match across all kinds.");
  }

  await client.end();
  return EXIT.OK;
}

// --- helpers ---

async function readCounts(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<CountsByKind> {
  const [w, m, c, f, r] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.workspaces),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.memories),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.comments),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.flags),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.relationships),
  ]);
  return {
    workspaces: w[0].n,
    memories: m[0].n,
    comments: c[0].n,
    flags: f[0].n,
    relationships: r[0].n,
  };
}

async function readCountsFromVault(root: string): Promise<CountsByKind> {
  const relPaths = await listMarkdownFiles(root);
  let memories = 0;
  let comments = 0;
  let flags = 0;
  let relationships = 0;
  for (const relPath of relPaths) {
    let md: string;
    try {
      md = await readMarkdown(root, relPath);
    } catch {
      continue;
    }
    try {
      const parsed = parseMemoryFile(md);
      memories += 1;
      comments += parsed.comments.length;
      flags += parsed.flags.length;
      relationships += parsed.relationships.length;
    } catch {
      continue;
    }
  }
  const wsEntries = await readdir(`${root}/workspaces`, {
    withFileTypes: true,
  }).catch(() => []);
  const workspaces = wsEntries.filter((e) => e.isDirectory()).length;
  return { workspaces, memories, comments, flags, relationships };
}

function rowToMemory(row: typeof schema.memories.$inferSelect): Memory {
  return {
    id: row.id,
    project_id: row.project_id,
    workspace_id: row.workspace_id ?? null,
    content: row.content,
    title: row.title,
    type: row.type,
    scope: row.scope,
    tags: row.tags ?? null,
    author: row.author,
    source: row.source ?? null,
    session_id: row.session_id ?? null,
    metadata: row.metadata ?? null,
    embedding_model: row.embedding_model ?? null,
    embedding_dimensions: row.embedding_dimensions ?? null,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    verified_at: row.verified_at ?? null,
    archived_at: row.archived_at ?? null,
    verified_by: row.verified_by ?? null,
    last_comment_at: row.last_comment_at ?? null,
    // Computed counts: not stored in pg row; default to 0 for migration
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
  };
}

function rowToFlag(row: typeof schema.flags.$inferSelect): Flag {
  return {
    id: row.id,
    project_id: row.project_id,
    memory_id: row.memory_id,
    flag_type: row.flag_type,
    severity: row.severity,
    details: row.details,
    resolved_at: row.resolved_at ?? null,
    resolved_by: row.resolved_by ?? null,
    created_at: row.created_at,
  };
}

function rowToRelationship(
  row: typeof schema.relationships.$inferSelect,
): Relationship {
  return {
    id: row.id,
    project_id: row.project_id,
    source_id: row.source_id,
    target_id: row.target_id,
    type: row.type,
    description: row.description ?? null,
    confidence: row.confidence,
    created_by: row.created_by,
    created_via: row.created_via ?? null,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
  };
}

if (process.argv[1] && process.argv[1].endsWith("migrate-pg-to-vault.js")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(EXIT.WRITE);
    },
  );
}

export { main };
