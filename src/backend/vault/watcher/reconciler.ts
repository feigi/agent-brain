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

    const scopeLoc = inferScopeFromPath(relPath);
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
      this.deps.vaultIndex.register(m.id, {
        path: relPath,
        scope: m.scope,
        workspaceId: m.workspace_id,
        userId: scopeLoc?.userId ?? null,
        title: m.title,
      });
      return { action: "indexed", memoryId: m.id };
    }

    // Existing row: compare body hash.
    if (existingHash === hash) {
      // Body unchanged. Detect frontmatter change by comparing the registered
      // VaultIndex entry against current parsed values; if anything actionable
      // changed, push a meta-only update.
      const indexEntry = this.deps.vaultIndex.get(m.id);
      const currentUserId = scopeLoc?.userId ?? null;
      const fmChanged =
        indexEntry === undefined ||
        indexEntry.path !== relPath ||
        indexEntry.scope !== m.scope ||
        indexEntry.workspaceId !== m.workspace_id ||
        indexEntry.userId !== currentUserId ||
        indexEntry.title !== m.title;
      if (fmChanged) {
        await this.deps.vectorIndex.upsertMetaOnly({
          id: m.id,
          project_id: m.project_id,
          workspace_id: m.workspace_id,
          scope: m.scope,
          author: m.author,
          title: m.title,
          archived: false,
        });
        this.deps.vaultIndex.register(m.id, {
          path: relPath,
          scope: m.scope,
          workspaceId: m.workspace_id,
          userId: currentUserId,
          title: m.title,
        });
        return { action: "meta-updated", memoryId: m.id };
      }
      return {
        action: "skipped",
        memoryId: m.id,
        reason: "hash-and-meta-unchanged",
      };
    }

    // Hash differs — re-embed.
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
    this.deps.vaultIndex.register(m.id, {
      path: relPath,
      scope: m.scope,
      workspaceId: m.workspace_id,
      userId: scopeLoc?.userId ?? null,
      title: m.title,
    });
    return { action: "reembedded", memoryId: m.id };
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
