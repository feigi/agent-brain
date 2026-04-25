// src/backend/vault/watcher/types.ts

export type ReconcileSignal = "add" | "change" | "unlink";

export interface ReconcileResult {
  action:
    | "indexed"
    | "reembedded"
    | "meta-updated"
    | "archived"
    | "skipped"
    | "parse-error";
  memoryId?: string;
  reason?: string;
}

export interface IgnoreSet {
  // Record an internal write: absPath + the mtime observed *immediately
  // post-fsync* of our own write. Watcher uses this to skip its own commits.
  add(absPath: string, mtimeAfterWrite: number): void;
  // True only if the path is tracked AND the file's current mtime equals
  // the recorded mtime. mtime mismatch means an external edit collided
  // with our write window — caller should fall through to reconcile.
  has(absPath: string, currentMtime: number): boolean;
  // Schedules deletion of the entry after `graceMs` ms. graceMs must
  // outlast chokidar's awaitWriteFinish.stabilityThreshold so the change
  // event has time to fire and be checked.
  releaseAfter(absPath: string, graceMs: number): void;
}

export interface BootScanResult {
  scanned: number;
  reconciled: number;
  orphaned: number;
  parseErrors: number;
  embedErrors: number;
}
