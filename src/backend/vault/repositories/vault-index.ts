import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import matter from "gray-matter";
import { nanoid } from "nanoid";
import type { MemoryScope } from "../../../types/memory.js";
import { inferScopeFromPath, slugify } from "../io/paths.js";
import { listMarkdownFiles } from "../io/vault-fs.js";
import { logger } from "../../../utils/logger.js";

export interface IndexEntry {
  path: string;
  scope: MemoryScope;
  workspaceId: string | null;
  userId: string | null;
}

/**
 * Shared id→path index built from frontmatter at startup.
 * Provides O(1) lookup by memory id, slug generation with collision
 * handling, and path sync for git-pulled changes.
 */
export class VaultIndex {
  private readonly map = new Map<string, IndexEntry>();

  private constructor() {}

  /**
   * Build the index by scanning all .md files under `root` and
   * extracting the `id` field from each file's YAML frontmatter.
   */
  static async create(root: string): Promise<VaultIndex> {
    const index = new VaultIndex();
    let files: string[];
    try {
      files = await listMarkdownFiles(root);
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "ENOENT"
      )
        return index;
      throw err;
    }

    for (const rel of files) {
      const scopeLoc = inferScopeFromPath(rel);
      // Skip non-memory files (e.g. _workspace.md)
      if (scopeLoc === null) continue;

      try {
        const raw = await readFile(join(root, rel), "utf8");
        const { data: fm } = matter(raw);
        const id = fm.id;
        if (typeof id !== "string" || id.length === 0) {
          logger.warn("vault index: skipping file without frontmatter id", {
            path: rel,
          });
          continue;
        }
        if (index.map.has(id)) {
          logger.warn("vault index: duplicate frontmatter id", {
            id,
            existing: index.map.get(id)!.path,
            duplicate: rel,
          });
          continue; // keep first occurrence
        }
        index.map.set(id, { ...scopeLoc, path: rel });
      } catch (err) {
        logger.warn("vault index: failed to parse frontmatter", {
          path: rel,
          err,
        });
      }
    }

    return index;
  }

  /** O(1) path lookup by memory id. */
  resolve(id: string): string | null {
    return this.map.get(id)?.path ?? null;
  }

  /** Full index entry for a memory id. */
  get(id: string): IndexEntry | undefined {
    return this.map.get(id);
  }

  /** Whether the index contains the given id. */
  has(id: string): boolean {
    return this.map.has(id);
  }

  /** Register a new memory in the index after file creation. */
  register(id: string, entry: IndexEntry): void {
    this.map.set(id, entry);
  }

  /** Update the path for an existing entry after a file rename. */
  move(id: string, newPath: string): void {
    const entry = this.map.get(id);
    if (entry) {
      entry.path = newPath;
    }
  }

  /** Remove a memory from the index after archive/delete. */
  unregister(id: string): void {
    this.map.delete(id);
  }

  /**
   * Generate a slug for a title, checking for collisions in `targetDir`.
   * On collision, appends a `-<4-char-nanoid>` suffix.
   * Pass `excludeId` to skip the memory's own path during collision check
   * (needed when renaming — the memory's current path is not a collision).
   */
  slugForTitle(title: string, targetDir: string, excludeId?: string): string {
    const base = slugify(title);
    const candidate = `${targetDir}/${base}.md`;

    // Check if any existing entry occupies this path
    if (!this.pathExists(candidate, excludeId)) return base;

    // Collision — append a short nanoid suffix
    const suffix = nanoid(4);
    return `${base}-${suffix}`;
  }

  /** Iterate all registered entries. */
  entries(): Iterable<[string, IndexEntry]> {
    return this.map.entries();
  }

  /** Iterate all registered ids. */
  keys(): Iterable<string> {
    return this.map.keys();
  }

  /** Number of indexed memories. */
  get size(): number {
    return this.map.size;
  }

  /**
   * Reconcile the index with paths that changed on disk (e.g. after
   * `git pull`). For new/changed files, reads frontmatter to discover
   * the id. For deleted files, removes the stale entry.
   */
  async syncPaths(root: string, paths: string[]): Promise<void> {
    for (const rel of paths) {
      const scopeLoc = inferScopeFromPath(rel);
      if (scopeLoc === null) continue;

      const abs = join(root, rel);
      if (existsSync(abs)) {
        try {
          const raw = await readFile(abs, "utf8");
          const { data: fm } = matter(raw);
          const id = fm.id;
          if (typeof id !== "string" || id.length === 0) continue;
          this.register(id, { ...scopeLoc, path: rel });
        } catch (err) {
          logger.warn("vault index: syncPaths failed to parse frontmatter", {
            path: rel,
            err,
          });
        }
      } else {
        // File deleted — find entry by path and remove
        for (const [id, entry] of this.map) {
          if (entry.path === rel) {
            this.unregister(id);
            break;
          }
        }
      }
    }
  }

  /** Check whether any indexed entry occupies the given path. */
  private pathExists(path: string, excludeId?: string): boolean {
    // Normalize to posix separators for comparison
    const normalized = path.split("\\").join(posix.sep);
    for (const [id, entry] of this.map) {
      if (id === excludeId) continue;
      if (entry.path === normalized) return true;
    }
    return false;
  }

  /**
   * Check path consistency for all indexed entries.
   * Compares frontmatter-derived scope/workspace with the directory-implied
   * scope/workspace. Returns mismatch descriptions.
   */
  checkPathConsistency(): Array<{ memoryId: string; reason: string }> {
    const mismatches: Array<{ memoryId: string; reason: string }> = [];

    for (const [id, entry] of this.map) {
      const dirScope = inferScopeFromPath(entry.path);
      if (!dirScope) continue;

      if (dirScope.scope !== entry.scope) {
        mismatches.push({
          memoryId: id,
          reason: `File at ${entry.path} has frontmatter scope '${entry.scope}' but directory implies '${dirScope.scope}'`,
        });
      } else if (dirScope.workspaceId !== entry.workspaceId) {
        mismatches.push({
          memoryId: id,
          reason: `File at ${entry.path} has frontmatter workspace_id '${entry.workspaceId}' but directory implies '${dirScope.workspaceId}'`,
        });
      } else if (dirScope.userId !== entry.userId) {
        mismatches.push({
          memoryId: id,
          reason: `File at ${entry.path} has frontmatter user_id '${entry.userId}' but directory implies '${dirScope.userId}'`,
        });
      }
    }

    return mismatches;
  }
}
