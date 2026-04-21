import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type {
  Memory,
  MemoryScope,
  MemoryWithRelevance,
} from "../../../types/memory.js";
import type {
  MemoryRepository,
  ListOptions,
  SearchOptions,
  StaleOptions,
  RecentWorkspaceAndUserOptions,
  ProjectScopedOptions,
  RecentActivityOptions,
  TeamActivityCounts,
} from "../../../repositories/types.js";
import { ConflictError, NotFoundError } from "../../../utils/errors.js";
import { NotImplementedError } from "../errors.js";
import {
  parseMemoryFile,
  serializeMemoryFile,
  type ParsedMemoryFile,
} from "../parser/memory-parser.js";
import {
  inferScopeFromPath,
  memoryPath,
  type MemoryLocation,
} from "../io/paths.js";
import {
  listMarkdownFiles,
  readMarkdown,
  writeMarkdownAtomic,
} from "../io/vault-fs.js";
import { withFileLock } from "../io/lock.js";

export interface VaultMemoryConfig {
  root: string;
}

interface IndexEntry {
  path: string;
  scope: MemoryScope;
  workspaceId: string | null;
  userId: string | null;
}

export class VaultMemoryRepository implements MemoryRepository {
  private readonly index: Map<string, IndexEntry>;

  private constructor(
    private readonly cfg: VaultMemoryConfig,
    initialIndex: Map<string, IndexEntry>,
  ) {
    this.index = initialIndex;
  }

  static async create(
    cfg: VaultMemoryConfig,
  ): Promise<VaultMemoryRepository> {
    const index = new Map<string, IndexEntry>();
    const files = await safeListMd(cfg.root);
    for (const rel of files) {
      const loc = inferScopeFromPath(rel);
      if (loc === null) continue; // skip _workspace.md and friends
      index.set(loc.id, {
        path: rel,
        scope: loc.scope,
        workspaceId: loc.workspaceId,
        userId: loc.userId,
      });
    }
    return new VaultMemoryRepository(cfg, index);
  }

  // ---- CRUD -----------------------------------------------------------

  async create(
    memory: Memory & { embedding: number[] },
  ): Promise<Memory> {
    const loc = locationFor(memory);
    const rel = memoryPath(loc);
    const md = serializeMemoryFile({
      memory,
      comments: [],
      relationships: [],
      flags: [],
    });
    const abs = join(this.cfg.root, rel);
    await ensurePlaceholder(abs);
    await withFileLock(abs, async () => {
      await writeMarkdownAtomic(this.cfg.root, rel, md);
    });
    this.index.set(memory.id, {
      path: rel,
      scope: loc.scope,
      workspaceId: loc.workspaceId,
      userId: loc.userId,
    });
    const saved = await this.#read(memory.id);
    return saved.memory;
  }

  async findById(id: string): Promise<Memory | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    const { memory } = await this.#read(id);
    return memory.archived_at === null ? memory : null;
  }

  async findByIdIncludingArchived(id: string): Promise<Memory | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    const { memory } = await this.#read(id);
    return memory;
  }

  async findByIds(ids: string[]): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const id of ids) {
      const m = await this.findById(id);
      if (m !== null) out.push(m);
    }
    return out;
  }

  async update(
    id: string,
    expectedVersion: number,
    updates: Partial<Memory> & { embedding?: number[] | null },
  ): Promise<Memory> {
    const entry = this.index.get(id);
    if (!entry) throw new NotFoundError("memory", id);

    const abs = join(this.cfg.root, entry.path);
    return await withFileLock(abs, async () => {
      const raw = await readMarkdown(this.cfg.root, entry.path);
      const parsed = parseMemoryFile(raw);
      if (parsed.memory.version !== expectedVersion)
        throw new ConflictError(
          `version mismatch: expected ${expectedVersion}, found ${parsed.memory.version}`,
        );

      // Drop embedding: phase-2 ignores the vector, phase-3 will wire it
      // to LanceDB. The partial update is applied verbatim otherwise.
      const { embedding: _emb, ...rest } = updates;
      void _emb;

      const next: Memory = {
        ...parsed.memory,
        ...rest,
        version: parsed.memory.version + 1,
        updated_at: new Date(),
      };
      const md = serializeMemoryFile({
        memory: next,
        comments: parsed.comments,
        relationships: parsed.relationships,
        flags: parsed.flags,
      });
      await writeMarkdownAtomic(this.cfg.root, entry.path, md);
      const reread = await this.#read(id);
      return reread.memory;
    });
  }

  async archive(ids: string[]): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const id of ids) {
      const entry = this.index.get(id);
      if (!entry) continue;
      const abs = join(this.cfg.root, entry.path);
      await withFileLock(abs, async () => {
        const raw = await readMarkdown(this.cfg.root, entry.path);
        const parsed = parseMemoryFile(raw);
        if (parsed.memory.archived_at !== null) return; // already archived
        const md = serializeMemoryFile({
          memory: { ...parsed.memory, archived_at: now, updated_at: now },
          comments: parsed.comments,
          relationships: parsed.relationships,
          flags: parsed.flags,
        });
        await writeMarkdownAtomic(this.cfg.root, entry.path, md);
        count += 1;
      });
    }
    return count;
  }

  async verify(id: string, verifiedBy: string): Promise<Memory | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    const abs = join(this.cfg.root, entry.path);
    return await withFileLock(abs, async () => {
      const raw = await readMarkdown(this.cfg.root, entry.path);
      const parsed = parseMemoryFile(raw);
      const now = new Date();
      const next: Memory = {
        ...parsed.memory,
        verified_at: now,
        verified_by: verifiedBy,
        updated_at: now,
      };
      const md = serializeMemoryFile({
        memory: next,
        comments: parsed.comments,
        relationships: parsed.relationships,
        flags: parsed.flags,
      });
      await writeMarkdownAtomic(this.cfg.root, entry.path, md);
      const reread = await this.#read(id);
      return reread.memory;
    });
  }

  // ---- Listings (stubbed in Task 12; implemented in Task 13) ----------

  async list(_options: ListOptions): ReturnType<MemoryRepository["list"]> {
    throw new NotImplementedError("list");
  }
  async findStale(
    _options: StaleOptions,
  ): ReturnType<MemoryRepository["findStale"]> {
    throw new NotImplementedError("findStale");
  }
  async listProjectScoped(
    _options: ProjectScopedOptions,
  ): Promise<Memory[]> {
    throw new NotImplementedError("listProjectScoped");
  }
  async listRecentWorkspaceAndUser(
    _options: RecentWorkspaceAndUserOptions,
  ): Promise<Memory[]> {
    throw new NotImplementedError("listRecentWorkspaceAndUser");
  }
  async findRecentActivity(
    _options: RecentActivityOptions,
  ): Promise<Memory[]> {
    throw new NotImplementedError("findRecentActivity");
  }
  async countTeamActivity(
    _projectId: string,
    _workspaceId: string,
    _userId: string,
    _since: Date,
  ): Promise<TeamActivityCounts> {
    throw new NotImplementedError("countTeamActivity");
  }
  async listDistinctWorkspaces(_projectId: string): Promise<string[]> {
    throw new NotImplementedError("listDistinctWorkspaces");
  }

  // ---- Vector methods (Phase 3) ---------------------------------------

  async search(_options: SearchOptions): Promise<MemoryWithRelevance[]> {
    throw new NotImplementedError("search");
  }
  async findDuplicates(): ReturnType<MemoryRepository["findDuplicates"]> {
    throw new NotImplementedError("findDuplicates");
  }
  async findPairwiseSimilar(): ReturnType<
    MemoryRepository["findPairwiseSimilar"]
  > {
    throw new NotImplementedError("findPairwiseSimilar");
  }
  async listWithEmbeddings(): ReturnType<
    MemoryRepository["listWithEmbeddings"]
  > {
    throw new NotImplementedError("listWithEmbeddings");
  }

  // ---- internals ------------------------------------------------------

  async #read(id: string): Promise<ParsedMemoryFile> {
    const entry = this.index.get(id);
    if (!entry) throw new NotFoundError("memory", id);
    const raw = await readMarkdown(this.cfg.root, entry.path);
    return parseMemoryFile(raw);
  }
}

function locationFor(memory: Memory): MemoryLocation {
  return {
    id: memory.id,
    scope: memory.scope,
    workspaceId: memory.workspace_id,
    userId: null, // user-scope userId currently not encoded on Memory
  };
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

// proper-lockfile requires the target to exist. Create parent dirs +
// zero-byte placeholder if missing. EEXIST from a racing create is
// fine — the existing file will be overwritten atomically by writeAtomic.
async function ensurePlaceholder(abs: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  try {
    await writeFile(abs, "", { flag: "wx" });
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "EEXIST"
    )
      return;
    throw err;
  }
}
