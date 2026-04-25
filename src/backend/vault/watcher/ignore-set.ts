// src/backend/vault/watcher/ignore-set.ts
import type { IgnoreSet } from "./types.js";

interface Entry {
  mtime: number;
  releaseTimer: NodeJS.Timeout | null;
}

// In-flight write tracker. Mutation sites call add(absPath, mtime) post-fsync,
// then releaseAfter(absPath, graceMs) once the write has fully settled (commit
// + lance write + lock release). Watcher consults has(absPath, currentMtime)
// to decide whether a chokidar event was caused by our own write.
//
// has() compares mtime so an external edit landing during the grace window
// (e.g. user edits the same file between our fsync and grace expiry) is NOT
// silently skipped — caller falls through to reconcile.
export class IgnoreSetImpl implements IgnoreSet {
  private readonly map = new Map<string, Entry>();

  add(absPath: string, mtimeAfterWrite: number): void {
    const existing = this.map.get(absPath);
    if (existing?.releaseTimer) clearTimeout(existing.releaseTimer);
    this.map.set(absPath, { mtime: mtimeAfterWrite, releaseTimer: null });
  }

  has(absPath: string, currentMtime: number): boolean {
    const entry = this.map.get(absPath);
    if (entry === undefined) return false;
    return entry.mtime === currentMtime;
  }

  releaseAfter(absPath: string, graceMs: number): void {
    const entry = this.map.get(absPath);
    if (entry === undefined) return;
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
    entry.releaseTimer = setTimeout(() => {
      this.map.delete(absPath);
    }, graceMs);
    if (typeof entry.releaseTimer.unref === "function") {
      entry.releaseTimer.unref();
    }
  }
}

export class NoopIgnoreSet implements IgnoreSet {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  add(absPath: string, mtimeAfterWrite: number): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  has(absPath: string, currentMtime: number): boolean {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  releaseAfter(absPath: string, graceMs: number): void {}
}
