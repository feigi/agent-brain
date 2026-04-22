import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseMemoryFile } from "./parser/memory-parser.js";
import { inferScopeFromPath } from "./io/paths.js";
import type { VaultVectorIndex, IndexRow } from "./vector/lance-index.js";
import type { BackendSessionStartMeta } from "../types.js";
import type { SyncResult } from "./git/pull.js";
import { logger } from "../../utils/logger.js";

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
    if (inferScopeFromPath(rel) === null) continue;
    const abs = join(cfg.root, rel);
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        logger.debug(`diffReindex: skip missing ${rel}: ${msg}`);
      } else {
        logger.warn(`diffReindex: unreadable ${rel}: ${msg}`);
      }
      continue;
    }
    let parsed: ReturnType<typeof parseMemoryFile>;
    try {
      parsed = parseMemoryFile(raw);
    } catch (err) {
      logger.warn(
        `diffReindex: parse failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
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

export interface PushQueueHandle {
  unpushedCommits(): Promise<number>;
  lastPushError?(): string | null;
  request(): void;
}

export interface RunSessionStartConfig {
  root: string;
  vectorIndex: VaultVectorIndex;
  embed: Embedder;
  syncFromRemote: () => Promise<SyncResult>;
  pushQueue: PushQueueHandle;
  // Ordering matters: callback runs before reindex so findById resolves.
  onChangedPaths?: (paths: string[]) => void;
}

export async function runSessionStart(
  cfg: RunSessionStartConfig,
): Promise<BackendSessionStartMeta> {
  const meta: BackendSessionStartMeta = {};
  const pull = await cfg.syncFromRemote();

  let parseErrors = 0;
  switch (pull.kind) {
    case "offline":
      meta.offline = true;
      break;
    case "conflict":
      meta.pull_conflict = true;
      if (pull.rebaseWedged) meta.rebase_wedged = true;
      break;
    case "ok":
      if (pull.changedPaths.length > 0) {
        cfg.onChangedPaths?.(pull.changedPaths);
        const result = await diffReindex({
          paths: pull.changedPaths,
          root: cfg.root,
          vectorIndex: cfg.vectorIndex,
          embed: cfg.embed,
        });
        parseErrors = result.parseErrors;
      }
      break;
  }
  if (parseErrors > 0) meta.parse_errors = parseErrors;

  const unpushed = await cfg.pushQueue.unpushedCommits();
  if (unpushed > 0) meta.unpushed_commits = unpushed;
  if (unpushed > 0) {
    const lastErr = cfg.pushQueue.lastPushError?.();
    if (lastErr) meta.last_push_error = lastErr;
  }
  cfg.pushQueue.request(); // kick drain

  return meta;
}
