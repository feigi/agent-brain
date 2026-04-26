#!/usr/bin/env node
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import * as schema from "../db/schema.js";
import { PostgresBackend } from "../backend/postgres/index.js";
import { VaultBackend } from "../backend/vault/index.js";
import {
  listMarkdownFiles,
  readMarkdown,
} from "../backend/vault/io/vault-fs.js";
import { parseMemoryFile } from "../backend/vault/parser/memory-parser.js";
import { createEmbeddingProvider } from "../providers/embedding/index.js";
import {
  checkDims,
  checkTargetEmpty,
  checkDrizzleCurrent,
} from "./migrate/preflight.js";
import { compareCounts } from "./migrate/verify.js";
import { runVaultToPg, type VaultSource } from "./migrate/vault-to-pg.js";
import { EXIT, type ExitCode, type CountsByKind } from "./migrate/types.js";
import type { Memory } from "../types/memory.js";
import type { Flag } from "../types/flag.js";
import type { Relationship } from "../types/relationship.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Args {
  vaultRoot: string;
  pgUrl: string;
  projectId: string;
  embeddingDimensions: number;
  reembed: boolean;
  verify: boolean;
  dryRun: boolean;
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
    yes: has("--yes"),
  };
}

async function main(argv: readonly string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  console.log(
    `vault→pg migration:\n` +
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

  let client: ReturnType<typeof postgres> | null = null;
  let vaultBackend: VaultBackend | null = null;
  let pgBackend: PostgresBackend | null = null;

  try {
    client = postgres(args.pgUrl, { onnotice: () => {} });
    const db = drizzle(client, { schema });

    // Preflight: target empty
    const targetEmpty = await checkTargetEmpty({
      countMemories: async () => {
        const rows = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.memories);
        return rows[0].n;
      },
    });
    if (!targetEmpty.ok) {
      console.error(`preflight: ${targetEmpty.reason}`);
      return EXIT.PREFLIGHT;
    }

    // Preflight: drizzle currency
    const expectedHash = await readExpectedHash();
    const drizzleCheck = await checkDrizzleCurrent({
      latestApplied: async () => {
        const rows = await (client as NonNullable<typeof client>)<
          Array<{ hash: string }>
        >`
          SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1
        `;
        return rows.length === 0 ? null : rows[0].hash;
      },
      expectedHash,
    });
    if (!drizzleCheck.ok) {
      console.error(`preflight: ${drizzleCheck.reason}`);
      return EXIT.PREFLIGHT;
    }

    // Source backend (vault) in migration mode
    vaultBackend = await VaultBackend.create({
      root: args.vaultRoot,
      projectId: args.projectId,
      embeddingDimensions: args.embeddingDimensions,
      migrationMode: true,
    });

    // Preflight: dim check (vault dims vs configured target dims)
    const sourceDim = vaultBackend.vectorDims;
    const dimCheck = checkDims({
      sourceDim,
      destDim: args.embeddingDimensions,
      reembed: args.reembed,
    });
    if (!dimCheck.ok) {
      console.error(`preflight: ${dimCheck.reason}`);
      return EXIT.PREFLIGHT;
    }

    const counts = await readVaultCounts(args.vaultRoot);
    console.log(
      `source counts: workspaces=${counts.workspaces} memories=${counts.memories} ` +
        `comments=${counts.comments} flags=${counts.flags} relationships=${counts.relationships}`,
    );

    if (args.dryRun) {
      console.log("dry-run: exiting without writes.");
      return EXIT.OK;
    }

    // Vault source reader (uses parser walk + lance for embeddings)
    const source = await buildVaultSource(
      args.vaultRoot,
      vaultBackend,
      counts,
      args.reembed,
    );

    pgBackend = await PostgresBackend.create(args.pgUrl);
    const provider = createEmbeddingProvider();
    const embedder = (text: string): Promise<number[]> => provider.embed(text);

    try {
      await runVaultToPg({
        source,
        destination: pgBackend,
        reembed: args.reembed,
        embedder,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`write phase failed: ${msg}`);
      return EXIT.WRITE;
    }

    if (args.verify) {
      const dest = await readCountsFromPg(client);
      const diff = compareCounts(counts, dest);
      if (diff.length > 0) {
        for (const d of diff) {
          console.error(
            `verify mismatch: ${d.kind} source=${d.source} destination=${d.destination}`,
          );
        }
        return EXIT.VERIFY;
      }
      console.log("verify: counts match across all kinds.");
    }

    return EXIT.OK;
  } finally {
    if (pgBackend) await pgBackend.close().catch(() => {});
    if (vaultBackend) await vaultBackend.close().catch(() => {});
    if (client) await client.end().catch(() => {});
  }
}

// --- helpers ---

async function readExpectedHash(): Promise<string> {
  const journalPath = resolve(__dirname, "../../drizzle/meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  if (journal.entries.length === 0) return "";
  return journal.entries[journal.entries.length - 1].tag;
}

async function readVaultCounts(root: string): Promise<CountsByKind> {
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

async function buildVaultSource(
  root: string,
  backend: VaultBackend,
  counts: CountsByKind,
  reembed: boolean,
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
    const vecRow = await backend.lookupVector(parsed.memory.id);
    if (!vecRow && !reembed) {
      throw new Error(
        `lance index missing embedding for memory id=${parsed.memory.id} ` +
          `(file: ${relPath}). Re-run with --reembed to regenerate vectors, or ` +
          `repair the lance index before retrying.`,
      );
    }
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

  return {
    readWorkspaces: async () => workspaces,
    readMemoriesWithEmbeddings: async () => memoryRows,
    readComments: async () => commentRows,
    readFlags: async () => flagRows,
    readRelationships: async () => relationshipRows,
    counts: async () => counts,
  };
}

async function readCountsFromPg(
  client: ReturnType<typeof postgres>,
): Promise<CountsByKind> {
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

if (process.argv[1] && process.argv[1].endsWith("migrate-vault-to-pg.js")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(EXIT.WRITE);
    },
  );
}

export { main };
