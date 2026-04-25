// src/backend/vault/watcher/reconciler.ts
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { logger } from "../../../utils/logger.js";
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
      const relPath = relative(this.deps.vaultRoot, absPath);
      const memoryId = this.findIdByPath(relPath);
      if (memoryId === null) {
        // Path was never registered (or already cleaned up). Task 9 may add
        // unindexable cleanup here once VaultIndex exposes a public API.
        return { action: "skipped", reason: "unknown-path" };
      }
      try {
        await this.deps.vectorIndex.markArchived(memoryId);
      } catch (err) {
        logger.error(`reconciler: markArchived failed for ${memoryId}`, {
          err,
        });
      }
      this.deps.vaultIndex.unregister(memoryId);
      await this.resolveOpenParseErrorFlags(memoryId);
      return { action: "archived", memoryId };
    }

    const raw = await readFile(absPath, "utf8");
    const relPath = relative(this.deps.vaultRoot, absPath);

    let parsed: ReturnType<typeof parseMemoryFile>;
    try {
      parsed = parseMemoryFile(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const memoryId = this.findIdByPath(relPath);
      if (memoryId === null) {
        this.deps.vaultIndex.setUnindexable(relPath, reason);
        return { action: "parse-error", reason };
      }
      const already = await this.deps.flagService.hasOpenFlag(
        memoryId,
        "parse_error",
      );
      if (!already) {
        try {
          await this.deps.flagService.createFlag({
            memoryId,
            flagType: "parse_error",
            severity: "needs_review",
            details: { reason: `Parse error in ${relPath}: ${reason}` },
          });
        } catch (writeErr) {
          logger.warn(
            `reconciler: createFlag(parse_error) failed for ${memoryId}`,
            { err: writeErr },
          );
        }
      }
      return { action: "parse-error", memoryId, reason };
    }

    // Parse succeeded — clear any stale unindexable entry.
    this.deps.vaultIndex.clearUnindexable(relPath);

    const result = await this.applySuccessfulParse(parsed, relPath);

    // Auto-resolve any open parse_error flag now that the file parses cleanly.
    await this.resolveOpenParseErrorFlags(parsed.memory.id);

    return result;
  }

  private async applySuccessfulParse(
    parsed: ReturnType<typeof parseMemoryFile>,
    relPath: string,
  ): Promise<ReconcileResult> {
    const m = parsed.memory;
    const hash = sha256Hex(m.content);
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

  private findIdByPath(relPath: string): string | null {
    for (const [id, entry] of this.deps.vaultIndex.entries()) {
      if (entry.path === relPath) return id;
    }
    return null;
  }

  private async resolveOpenParseErrorFlags(memoryId: string): Promise<void> {
    const flags = await this.deps.flagService.getFlagsByMemoryId(memoryId);
    for (const f of flags) {
      if (f.flag_type !== "parse_error") continue;
      if (f.resolved_at != null) continue;
      try {
        await this.deps.flagService.resolveFlag(
          f.id,
          "agent-brain",
          "accepted",
        );
      } catch (err) {
        logger.warn(
          `reconciler: failed to resolve parse_error flag ${f.id} for ${memoryId}`,
          { err },
        );
      }
    }
  }

  async archiveOrphans(
    diskPaths: ReadonlySet<string>,
  ): Promise<{ archived: string[] }> {
    const archived: string[] = [];
    // Snapshot the entries to avoid mutating during iteration.
    const entries = Array.from(this.deps.vaultIndex.entries());
    for (const [id, entry] of entries) {
      const abs = join(this.deps.vaultRoot, entry.path);
      if (diskPaths.has(abs)) continue;
      try {
        await this.deps.vectorIndex.markArchived(id);
        this.deps.vaultIndex.unregister(id);
        archived.push(id);
      } catch (err) {
        logger.error(
          `reconciler: archiveOrphans failed for ${id} (path=${entry.path})`,
          { err },
        );
      }
    }
    return { archived };
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
