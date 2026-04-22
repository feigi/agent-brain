import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseMemoryFile } from "./parser/memory-parser.js";
import type { VaultVectorIndex, IndexRow } from "./vector/lance-index.js";
import { logger } from "../../utils/logger.js";

const MEMORY_PATH_RE =
  /^(workspaces\/[^/]+\/memories\/|project\/memories\/|users\/[^/]+\/memories\/).+\.md$/;

export type Embedder = (text: string) => Promise<number[]>;

export interface DiffReindexConfig {
  paths: string[];
  root: string;
  vectorIndex: VaultVectorIndex;
  embed: Embedder;
}

export interface DiffReindexResult {
  parseErrors: number;
}

export async function diffReindex(
  cfg: DiffReindexConfig,
): Promise<DiffReindexResult> {
  let parseErrors = 0;
  for (const rel of cfg.paths) {
    if (!MEMORY_PATH_RE.test(rel)) continue;
    const abs = join(cfg.root, rel);
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch (err) {
      logger.debug(
        `diffReindex: skip unreadable ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    let parsed: ReturnType<typeof parseMemoryFile>;
    try {
      parsed = parseMemoryFile(raw);
    } catch {
      parseErrors += 1;
      continue;
    }
    const { memory } = parsed;
    const newHash = sha256(memory.content);
    const existingHash = await cfg.vectorIndex.getContentHash(memory.id);

    if (existingHash === newHash) {
      // Metadata-only refresh: preserve the existing vector.
      await cfg.vectorIndex.upsertMetaOnly({
        id: memory.id,
        project_id: memory.project_id,
        workspace_id: memory.workspace_id,
        scope: memory.scope,
        author: memory.author,
        title: memory.title,
        archived: memory.archived_at !== null,
      });
      continue;
    }
    const embedding = await cfg.embed(memory.content);
    await cfg.vectorIndex.upsert([buildRow(memory, newHash, embedding)]);
  }
  return { parseErrors };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function buildRow(
  memory: {
    id: string;
    project_id: string;
    workspace_id: string | null;
    scope: "workspace" | "user" | "project";
    author: string;
    title: string;
    archived_at: Date | null;
  },
  contentHash: string,
  embedding: number[],
): IndexRow {
  return {
    id: memory.id,
    project_id: memory.project_id,
    workspace_id: memory.workspace_id,
    scope: memory.scope,
    author: memory.author,
    title: memory.title,
    archived: memory.archived_at !== null,
    content_hash: contentHash,
    vector: embedding,
  };
}
