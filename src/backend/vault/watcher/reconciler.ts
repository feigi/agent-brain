// src/backend/vault/watcher/reconciler.ts
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { createHash } from "node:crypto";
import type { VaultIndex } from "../repositories/vault-index.js";
import type { VaultVectorIndex } from "../vector/lance-index.js";
import type { FlagService } from "../../../services/flag-service.js";
import { parseMemoryFile } from "../parser/memory-parser.js";
import { inferScopeFromPath } from "../io/paths.js";
import type { Embedder } from "../session-start.js";
import type { ReconcileResult, ReconcileSignal } from "./types.js";

export interface Reconciler {
  reconcileFile(
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<ReconcileResult>;
  archiveOrphans(
    diskPaths: ReadonlySet<string>,
  ): Promise<{ archived: string[] }>;
}

export interface ReconcilerDeps {
  vaultIndex: VaultIndex;
  vectorIndex: VaultVectorIndex;
  flagService: FlagService;
  embed: Embedder;
  vaultRoot: string;
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  return new ReconcilerImpl(deps);
}

class ReconcilerImpl implements Reconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  async reconcileFile(
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<ReconcileResult> {
    if (signal === "unlink") {
      return { action: "skipped", reason: "unlink-not-yet-implemented" };
    }

    const raw = await readFile(absPath, "utf8");
    const parsed = parseMemoryFile(raw);
    const m = parsed.memory;
    const hash = sha256Hex(m.content);
    const relPath = relative(this.deps.vaultRoot, absPath);

    const existingHash = await this.deps.vectorIndex.getContentHash(m.id);
    if (existingHash === null) {
      const vector = await this.deps.embed(m.content);
      await this.deps.vectorIndex.upsert([
        {
          id: m.id,
          project_id: m.project_id,
          workspace_id: m.workspace_id,
          scope: m.scope,
          author: m.author,
          title: m.title,
          archived: false,
          content_hash: hash,
          vector,
        },
      ]);
      const scopeLoc = inferScopeFromPath(relPath);
      this.deps.vaultIndex.register(m.id, {
        path: relPath,
        scope: m.scope,
        workspaceId: m.workspace_id,
        userId: scopeLoc?.userId ?? null,
      });
      return { action: "indexed", memoryId: m.id };
    }

    return { action: "skipped", reason: "change-not-yet-implemented" };
  }

  async archiveOrphans(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _diskPaths: ReadonlySet<string>,
  ): Promise<{ archived: string[] }> {
    return { archived: [] };
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
