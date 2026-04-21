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

  // ---- Listings -------------------------------------------------------

  async list(options: ListOptions): ReturnType<MemoryRepository["list"]> {
    const all = await this.#loadAll();
    const filtered = all.filter((m) => matchesList(m, options));
    const sortBy = options.sort_by ?? "created_at";
    const order = options.order ?? "desc";
    filtered.sort((a, b) => compareMemory(a, b, sortBy, order));
    const sliced = applyCursor(filtered, options.cursor, sortBy, order);
    const limit = options.limit ?? 50;
    const page = sliced.slice(0, limit);
    const has_more = sliced.length > limit;
    const last = page[page.length - 1];
    return {
      memories: page,
      has_more,
      cursor:
        has_more && last
          ? { created_at: last.created_at.toISOString(), id: last.id }
          : undefined,
    };
  }

  async findStale(
    options: StaleOptions,
  ): ReturnType<MemoryRepository["findStale"]> {
    const cutoff = new Date(
      Date.now() - options.threshold_days * 86_400_000,
    );
    const all = await this.#loadAll();
    const filtered = all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.workspace_id === options.workspace_id &&
          m.archived_at === null &&
          m.updated_at.getTime() < cutoff.getTime(),
      )
      .sort((a, b) => compareMemory(a, b, "created_at", "asc"));
    const sliced = applyCursor(filtered, options.cursor, "created_at", "asc");
    const limit = options.limit ?? 50;
    const page = sliced.slice(0, limit);
    const has_more = sliced.length > limit;
    const last = page[page.length - 1];
    return {
      memories: page,
      has_more,
      cursor:
        has_more && last
          ? { created_at: last.created_at.toISOString(), id: last.id }
          : undefined,
    };
  }

  async listProjectScoped(
    options: ProjectScopedOptions,
  ): Promise<Memory[]> {
    const all = await this.#loadAll();
    return all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.scope === "project" &&
          m.archived_at === null,
      )
      .sort((a, b) => compareMemory(a, b, "created_at", "desc"))
      .slice(0, options.limit);
  }

  async listRecentWorkspaceAndUser(
    options: RecentWorkspaceAndUserOptions,
  ): Promise<Memory[]> {
    const all = await this.#loadAll();
    return all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.archived_at === null &&
          ((m.scope === "workspace" && m.workspace_id === options.workspace_id) ||
            (m.scope === "user" && m.author === options.user_id)),
      )
      .sort((a, b) => compareMemory(a, b, "updated_at", "desc"))
      .slice(0, options.limit);
  }

  async findRecentActivity(
    options: RecentActivityOptions,
  ): Promise<Memory[]> {
    const all = await this.#loadAll();
    return all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.workspace_id === options.workspace_id &&
          m.archived_at === null &&
          m.updated_at.getTime() >= options.since.getTime() &&
          (!options.exclude_self || m.author !== options.user_id),
      )
      .sort((a, b) => compareMemory(a, b, "updated_at", "desc"))
      .slice(0, options.limit);
  }

  async countTeamActivity(
    projectId: string,
    workspaceId: string,
    userId: string,
    since: Date,
  ): Promise<TeamActivityCounts> {
    const all = await this.#loadAll();
    const scoped = all.filter(
      (m) =>
        m.project_id === projectId &&
        m.workspace_id === workspaceId &&
        m.archived_at === null &&
        m.author !== userId,
    );
    let new_memories = 0;
    let updated_memories = 0;
    let commented_memories = 0;
    for (const m of scoped) {
      if (m.created_at.getTime() >= since.getTime()) new_memories += 1;
      else if (m.updated_at.getTime() >= since.getTime())
        updated_memories += 1;
      if (
        m.last_comment_at !== null &&
        m.last_comment_at.getTime() >= since.getTime()
      )
        commented_memories += 1;
    }
    return { new_memories, updated_memories, commented_memories };
  }

  async listDistinctWorkspaces(projectId: string): Promise<string[]> {
    const all = await this.#loadAll();
    const set = new Set<string>();
    for (const m of all) {
      if (m.project_id === projectId && m.workspace_id !== null)
        set.add(m.workspace_id);
    }
    return Array.from(set);
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

  async #loadAll(): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const id of this.index.keys()) {
      const { memory } = await this.#read(id);
      out.push(memory);
    }
    return out;
  }

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

function matchesList(m: Memory, o: ListOptions): boolean {
  if (m.archived_at !== null) return false;
  if (m.project_id !== o.project_id) return false;
  if (!o.scope.includes(m.scope)) return false;
  if (o.workspace_id !== undefined && m.workspace_id !== o.workspace_id)
    return false;
  if (o.type !== undefined && m.type !== o.type) return false;
  if (o.tags !== undefined && o.tags.length > 0) {
    const haystack = new Set(m.tags ?? []);
    if (!o.tags.some((t) => haystack.has(t))) return false;
  }
  if (o.user_id !== undefined && m.scope === "user" && m.author !== o.user_id)
    return false;
  return true;
}

function compareMemory(
  a: Memory,
  b: Memory,
  sortBy: "created_at" | "updated_at",
  order: "asc" | "desc",
): number {
  const av = a[sortBy].getTime();
  const bv = b[sortBy].getTime();
  const primary = av - bv;
  if (primary !== 0) return order === "asc" ? primary : -primary;
  // Tiebreak on id for determinism.
  const cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return order === "asc" ? cmp : -cmp;
}

function applyCursor(
  sorted: Memory[],
  cursor: { created_at: string; id: string } | undefined,
  sortBy: "created_at" | "updated_at",
  order: "asc" | "desc",
): Memory[] {
  if (!cursor) return sorted;
  const cutoff = new Date(cursor.created_at).getTime();
  return sorted.filter((m) => {
    const v = m[sortBy].getTime();
    if (order === "desc") {
      if (v < cutoff) return true;
      if (v > cutoff) return false;
      return m.id < cursor.id;
    } else {
      if (v > cutoff) return true;
      if (v < cutoff) return false;
      return m.id > cursor.id;
    }
  });
}
