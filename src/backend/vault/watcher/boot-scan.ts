// src/backend/vault/watcher/boot-scan.ts
import { join } from "node:path";
import { listMarkdownFiles } from "../io/vault-fs.js";
import { logger } from "../../../utils/logger.js";
import type { Reconciler } from "./reconciler.js";
import type { BootScanResult } from "./types.js";

export interface RunBootScanOpts {
  vaultRoot: string;
  reconciler: Reconciler;
}

// Blocks pre-listen so HTTP only opens once vault is in sync with lance + vaultIndex.
export async function runBootScan(
  opts: RunBootScanOpts,
): Promise<BootScanResult> {
  const { vaultRoot, reconciler } = opts;
  const relPaths = await listMarkdownFiles(vaultRoot);

  let reconciled = 0;
  let parseErrors = 0;
  const embedErrorEntries: Array<{ path: string; reason: string }> = [];
  const diskPaths = new Set<string>();

  for (const rel of relPaths) {
    const abs = join(vaultRoot, rel);
    diskPaths.add(abs);
    try {
      const result = await reconciler.reconcileFile(abs, "add");
      switch (result.action) {
        case "indexed":
        case "reembedded":
        case "meta-updated":
        case "skipped":
        case "archived":
          reconciled++;
          break;
        case "parse-error":
          parseErrors++;
          break;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      embedErrorEntries.push({ path: abs, reason });
      logger.error(`runBootScan: reconcile failed for ${abs}`, { err });
    }
  }

  const orphan = await reconciler.archiveOrphans(diskPaths);

  return {
    scanned: relPaths.length,
    reconciled,
    orphaned: orphan.archived.length,
    parseErrors,
    embedErrors: embedErrorEntries.length,
    embedErrorEntries,
  };
}
