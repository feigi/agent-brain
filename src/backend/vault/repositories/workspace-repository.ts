import matter from "gray-matter";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceRepository } from "../../../repositories/types.js";
import { workspaceMetaPath } from "../io/paths.js";
import { readMarkdown, writeMarkdownAtomic } from "../io/vault-fs.js";
import { withFileLock } from "../io/lock.js";

export interface VaultWorkspaceConfig {
  root: string;
}

interface WorkspaceFm {
  id: string;
  created: string;
}

export class VaultWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly cfg: VaultWorkspaceConfig) {}

  async findOrCreate(slug: string): Promise<{ id: string; created_at: Date }> {
    const rel = workspaceMetaPath(slug);
    const abs = join(this.cfg.root, rel);

    // Ensure the parent directory exists so proper-lockfile can lock the path.
    await mkdir(dirname(abs), { recursive: true });

    // Create a zero-byte placeholder with exclusive flag so only one concurrent
    // caller wins the initial creation; EEXIST is silently ignored.
    try {
      await writeFile(abs, "", { flag: "wx" });
    } catch (err: unknown) {
      if (!isNodeEexist(err)) throw err;
    }

    return await withFileLock(abs, async () => {
      try {
        const raw = await readMarkdown(this.cfg.root, rel);
        const fm = matter(raw).data as Partial<WorkspaceFm>;
        if (typeof fm.id === "string" && typeof fm.created === "string") {
          return { id: fm.id, created_at: new Date(fm.created) };
        }
        // File exists but is empty (placeholder) or malformed — write it now.
      } catch (err: unknown) {
        if (!isNodeEnoent(err)) throw err;
        // Unexpected: placeholder should exist, but fall through to write.
      }

      const created = new Date();
      const body = matter.stringify(`# ${slug}\n`, {
        id: slug,
        created: created.toISOString(),
      });
      await writeMarkdownAtomic(this.cfg.root, rel, body);
      return { id: slug, created_at: created };
    });
  }

  async findById(
    slug: string,
  ): Promise<{ id: string; created_at: Date } | null> {
    try {
      const raw = await readMarkdown(this.cfg.root, workspaceMetaPath(slug));
      const fm = matter(raw).data as Partial<WorkspaceFm>;
      if (typeof fm.id !== "string" || typeof fm.created !== "string")
        return null;
      return { id: fm.id, created_at: new Date(fm.created) };
    } catch (err: unknown) {
      if (isNodeEnoent(err)) return null;
      throw err;
    }
  }
}

function isNodeEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function isNodeEexist(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "EEXIST"
  );
}
