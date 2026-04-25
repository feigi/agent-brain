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

// Walks every markdown file under <vaultRoot>, calls
// reconciler.reconcileFile(abs, "add") per file, then archiveOrphans(diskPaths).
// Blocks until consistent so HTTP listen only happens after the vault is in
// agreement with lance + vaultIndex.
export async function runBootScan(
  opts: RunBootScanOpts,
): Promise<BootScanResult> {
  const { vaultRoot, reconciler } = opts;
  const relPaths = await listMarkdownFiles(vaultRoot);

  let reconciled = 0;
  let parseErrors = 0;
  let embedErrors = 0;
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
      embedErrors++;
      logger.error(`runBootScan: reconcile failed for ${abs}`, { err });
    }
  }

  const orphan = await reconciler.archiveOrphans(diskPaths);

  return {
    scanned: relPaths.length,
    reconciled,
    orphaned: orphan.archived.length,
    parseErrors,
    embedErrors,
  };
}
