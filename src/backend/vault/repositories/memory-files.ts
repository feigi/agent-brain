import { join } from "node:path";
import { NotFoundError } from "../../../utils/errors.js";
import {
  parseMemoryFile,
  serializeMemoryFile,
  type ParsedMemoryFile,
} from "../parser/memory-parser.js";
import { inferScopeFromPath } from "../io/paths.js";
import {
  listMarkdownFiles,
  readMarkdown,
  writeMarkdownAtomic,
} from "../io/vault-fs.js";
import { withFileLock } from "../io/lock.js";

export interface VaultMemoryFilesConfig {
  root: string;
}

// Shared read/write coordination for the three repositories that persist
// inside a memory's markdown file (comments, flags, relationships).
// Uses a scan-based id→path lookup rather than an in-memory index so
// each embedded repo can be constructed independently. O(N) per call
// where N = memory file count — acceptable at Phase 2 scale; Phase 2b.3
// may lift the index into a shared service used by all vault repos.
export class VaultMemoryFiles {
  constructor(private readonly cfg: VaultMemoryFilesConfig) {}

  async resolvePath(memoryId: string): Promise<string | null> {
    const files = await safeListMd(this.cfg.root);
    for (const rel of files) {
      const loc = inferScopeFromPath(rel);
      if (loc?.id === memoryId) return rel;
    }
    return null;
  }

  async read(memoryId: string): Promise<ParsedMemoryFile | null> {
    const rel = await this.resolvePath(memoryId);
    if (rel === null) return null;
    const raw = await readMarkdown(this.cfg.root, rel);
    return parseMemoryFile(raw);
  }

  // Read-modify-write under file lock. Mutator returns the next parsed
  // file plus an arbitrary caller result. Throws NotFoundError if the
  // memory does not exist (same parity as pg FK failures).
  async edit<T>(
    memoryId: string,
    mutator: (parsed: ParsedMemoryFile) => {
      parsed: ParsedMemoryFile;
      result: T;
    },
  ): Promise<T> {
    const rel = await this.resolvePath(memoryId);
    if (rel === null) throw new NotFoundError("memory", memoryId);
    const abs = join(this.cfg.root, rel);
    return await withFileLock(abs, async () => {
      const raw = await readMarkdown(this.cfg.root, rel);
      const parsed = parseMemoryFile(raw);
      const { parsed: next, result } = mutator(parsed);
      await writeMarkdownAtomic(this.cfg.root, rel, serializeMemoryFile(next));
      return result;
    });
  }

  // Full-vault read for cross-memory queries (findOpenByWorkspace, etc.).
  // Non-memory files (e.g. _workspace.md, _audit/) are skipped.
  async listAllParsed(): Promise<
    Array<{ rel: string; parsed: ParsedMemoryFile }>
  > {
    const files = await safeListMd(this.cfg.root);
    const out: Array<{ rel: string; parsed: ParsedMemoryFile }> = [];
    for (const rel of files) {
      const loc = inferScopeFromPath(rel);
      if (loc === null) continue;
      const raw = await readMarkdown(this.cfg.root, rel);
      out.push({ rel, parsed: parseMemoryFile(raw) });
    }
    return out;
  }
}

async function safeListMd(root: string): Promise<string[]> {
  try {
    return await listMarkdownFiles(root);
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "ENOENT"
    )
      return [];
    throw err;
  }
}
