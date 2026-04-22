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
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../utils/errors.js";
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
import { VaultVectorIndex } from "../vector/lance-index.js";
import { contentHash } from "../vector/hash.js";
import { logger } from "../../../utils/logger.js";
import type { CommitTrailer, GitOps } from "../git/types.js";
import { NOOP_GIT_OPS } from "../git/types.js";
import { assertUsersIgnored } from "../git/users-gitignore-invariant.js";
import { commitSubject } from "./util.js";

export interface VaultMemoryConfig {
  root: string;
  index: VaultVectorIndex;
  gitOps?: GitOps;
  // When true, user-scope memories are committed alongside
  // workspace/project ones. Default false: `users/` stays gitignored
  // and its writes skip the commit step entirely (the path is ignored
  // by .gitignore so `git add` would no-op and `stageAndCommit` would
  // throw "nothing to commit").
  trackUsersInGit?: boolean;
}

interface IndexEntry {
  path: string;
  scope: MemoryScope;
  workspaceId: string | null;
  userId: string | null;
}

export class VaultMemoryRepository implements MemoryRepository {
  private readonly index: Map<string, IndexEntry>;
  private readonly gitOps: GitOps;
  private readonly trackUsersInGit: boolean;

  private constructor(
    private readonly cfg: VaultMemoryConfig,
    initialIndex: Map<string, IndexEntry>,
  ) {
    this.index = initialIndex;
    this.gitOps = cfg.gitOps ?? NOOP_GIT_OPS;
    this.trackUsersInGit = cfg.trackUsersInGit ?? false;
  }

  static async create(cfg: VaultMemoryConfig): Promise<VaultMemoryRepository> {
    const index = new Map<string, IndexEntry>();
    const files = await safeListMd(cfg.root);
    for (const rel of files) {
      const loc = inferScopeFromPath(rel);
      // Non-memory files (e.g. _workspace.md) don't match the three
      // memory layouts and are skipped here.
      if (loc === null) continue;
      index.set(loc.id, {
        path: rel,
        scope: loc.scope,
        workspaceId: loc.workspaceId,
        userId: loc.userId,
      });
    }
    return new VaultMemoryRepository(cfg, index);
  }

  async create(memory: Memory & { embedding: number[] }): Promise<Memory> {
    if (this.index.has(memory.id)) {
      throw new ConflictError(`memory already exists: ${memory.id}`);
    }
    // Dimension check before touching the filesystem: after markdown
    // is durably written, lance failures are swallowed (markdown is
    // source of truth), so a programmer-error wrong-dim embedding
    // here would leave the vault permanently out of sync with the
    // index. Fail fast before any write lands on disk.
    if (memory.embedding.length !== this.cfg.index.dims) {
      throw new ValidationError(
        `vector dimension mismatch: expected ${this.cfg.index.dims}, got ${memory.embedding.length} for id ${memory.id}`,
      );
    }
    // Privacy guard: refuse user-scope writes if the .gitignore rule
    // that keeps users/ out of the remote has been removed. Runs
    // before any disk mutation. No-op when trackUsersInGit is enabled.
    if (
      memory.scope === "user" &&
      !this.trackUsersInGit &&
      this.gitOps !== NOOP_GIT_OPS
    ) {
      await assertUsersIgnored(this.cfg.root);
    }
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
      // Re-check under lock: a racing create() on the same id may have
      // passed the index check and written content between the fast
      // path above and lock acquisition here. A non-empty file means
      // some other writer already committed; fail with ConflictError
      // rather than silently clobbering it.
      const existing = await readMarkdown(this.cfg.root, rel);
      if (existing.length > 0) {
        throw new ConflictError(`memory already exists: ${memory.id}`);
      }
      await writeMarkdownAtomic(this.cfg.root, rel, md);
    });
    this.index.set(memory.id, {
      path: rel,
      scope: loc.scope,
      workspaceId: loc.workspaceId,
      userId: loc.userId,
    });
    // Markdown is source of truth; lance is a derived cache. A lance
    // failure here leaves the new memory un-indexed until Phase 5's
    // watcher-driven reindex picks it up. Log and return success.
    try {
      await this.cfg.index.upsert([
        {
          id: memory.id,
          project_id: memory.project_id,
          workspace_id: memory.workspace_id,
          scope: memory.scope,
          author: memory.author,
          title: memory.title,
          archived: false,
          content_hash: contentHash(memory.content),
          vector: memory.embedding,
        },
      ]);
    } catch (err) {
      logger.warn("lance upsert failed on create; index stale", {
        id: memory.id,
        op: "create",
        err,
      });
    }
    await this.#commit(
      rel,
      memory.scope,
      commitSubject("created", memory.title),
      {
        action: "created",
        memoryId: memory.id,
        actor: memory.author,
      },
    );
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
    if (!entry)
      throw new ConflictError(
        `Memory ${id} update failed: not found or archived`,
      );

    // Pre-check embedding dim before acquiring the lock; same reason
    // as create() — markdown write succeeds then the lance call is
    // swallowed on failure, so dim-mismatch must fail before any on-
    // disk mutation.
    if (
      updates.embedding !== undefined &&
      updates.embedding !== null &&
      updates.embedding.length !== this.cfg.index.dims
    ) {
      throw new ValidationError(
        `vector dimension mismatch: expected ${this.cfg.index.dims}, got ${updates.embedding.length} for id ${id}`,
      );
    }

    if (
      entry.scope === "user" &&
      !this.trackUsersInGit &&
      this.gitOps !== NOOP_GIT_OPS
    ) {
      await assertUsersIgnored(this.cfg.root);
    }

    const abs = join(this.cfg.root, entry.path);
    return await withFileLock(abs, async () => {
      const raw = await readMarkdown(this.cfg.root, entry.path);
      const parsed = parseMemoryFile(raw);
      if (parsed.memory.archived_at !== null)
        throw new ConflictError(
          `Memory ${id} update failed: not found or archived`,
        );
      if (parsed.memory.version !== expectedVersion)
        throw new ConflictError(
          `Memory ${id} update failed: version mismatch (expected ${expectedVersion}, found ${parsed.memory.version})`,
        );

      // The markdown file persists only scalar fields; the embedding
      // (if provided) is written to the vector index below instead.
      const { embedding, ...rest } = updates;

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
      try {
        if (embedding !== undefined && embedding !== null) {
          await this.cfg.index.upsert([
            {
              id: next.id,
              project_id: next.project_id,
              workspace_id: next.workspace_id,
              scope: next.scope,
              author: next.author,
              title: next.title,
              archived: false,
              content_hash: contentHash(next.content),
              vector: embedding,
            },
          ]);
        } else {
          const rowsUpdated = await this.cfg.index.upsertMetaOnly({
            id: next.id,
            project_id: next.project_id,
            workspace_id: next.workspace_id,
            scope: next.scope,
            author: next.author,
            title: next.title,
            archived: false,
          });
          // lancedb's update() is a no-op on zero matches. A missing
          // row means the lance index and markdown vault have drifted
          // — e.g. a previous create() swallowed an upsert failure.
          // Markdown still wins; surface the drift for Phase 5 repair.
          if (rowsUpdated === 0) {
            logger.warn("lance meta-only update matched no rows; index drift", {
              id: next.id,
              op: "update",
            });
          }
        }
      } catch (err) {
        logger.warn("lance upsert failed on update; index stale", {
          id: next.id,
          op: "update",
          err,
        });
      }
      await this.#commit(
        entry.path,
        next.scope,
        commitSubject("updated", next.title),
        { action: "updated", memoryId: next.id, actor: next.author },
      );
      const reread = await this.#read(id);
      return reread.memory;
    });
  }

  async archive(ids: string[]): Promise<number> {
    let count = 0;
    const now = new Date();
    const archived: Array<{
      id: string;
      path: string;
      scope: MemoryScope;
      title: string;
      author: string;
    }> = [];
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
        archived.push({
          id,
          path: entry.path,
          scope: entry.scope,
          title: parsed.memory.title,
          author: parsed.memory.author,
        });
      });
    }
    // One lance failure (or missing row) must not abort archive
    // propagation for the remaining ids. Markdown is already flipped
    // for each id in `archived`, so the caller's return count is
    // accurate regardless of lance outcome.
    for (const rec of archived) {
      try {
        const rowsUpdated = await this.cfg.index.markArchived(rec.id);
        if (rowsUpdated === 0) {
          logger.warn("lance markArchived matched no rows; index drift", {
            id: rec.id,
            op: "archive",
          });
        }
      } catch (err) {
        logger.warn("lance markArchived failed; index stale", {
          id: rec.id,
          op: "archive",
          err,
        });
      }
      await this.#commit(
        rec.path,
        rec.scope,
        commitSubject("archived", rec.title),
        { action: "archived", memoryId: rec.id, actor: rec.author },
      );
    }
    return count;
  }

  async verify(id: string, verifiedBy: string): Promise<Memory | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    if (
      entry.scope === "user" &&
      !this.trackUsersInGit &&
      this.gitOps !== NOOP_GIT_OPS
    ) {
      await assertUsersIgnored(this.cfg.root);
    }
    const abs = join(this.cfg.root, entry.path);
    return await withFileLock(abs, async () => {
      const raw = await readMarkdown(this.cfg.root, entry.path);
      const parsed = parseMemoryFile(raw);
      if (parsed.memory.archived_at !== null) return null;
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
      await this.#commit(
        entry.path,
        next.scope,
        commitSubject("verified", next.title),
        { action: "verified", memoryId: next.id, actor: verifiedBy },
      );
      const reread = await this.#read(id);
      return reread.memory;
    });
  }

  async list(options: ListOptions): ReturnType<MemoryRepository["list"]> {
    validateListScope(options);
    const all = await this.#loadAll();
    const filtered = all.filter((m) => matchesList(m, options));
    const sortBy = options.sort_by ?? "created_at";
    const order = options.order ?? "desc";
    filtered.sort((a, b) => compareMemory(a, b, sortBy, order));
    const sliced = applyCursor(filtered, options.cursor, sortBy, order);
    const limit = options.limit ?? 20;
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
    const cutoff = new Date(Date.now() - options.threshold_days * 86_400_000);
    const all = await this.#loadAll();
    const filtered = all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.workspace_id === options.workspace_id &&
          m.archived_at === null &&
          (m.verified_at ?? m.created_at).getTime() < cutoff.getTime(),
      )
      .sort((a, b) => compareMemory(a, b, "created_at", "desc"));
    const sliced = applyCursor(filtered, options.cursor, "created_at", "desc");
    const limit = options.limit ?? 20;
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

  async listProjectScoped(options: ProjectScopedOptions): Promise<Memory[]> {
    const all = await this.#loadAll();
    return all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.scope === "project" &&
          m.workspace_id === null &&
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
          ((m.scope === "workspace" &&
            m.workspace_id === options.workspace_id) ||
            (m.scope === "user" && m.author === options.user_id)),
      )
      .sort((a, b) => compareMemory(a, b, "created_at", "desc"))
      .slice(0, options.limit);
  }

  async findRecentActivity(options: RecentActivityOptions): Promise<Memory[]> {
    const all = await this.#loadAll();
    return all
      .filter((m) => {
        if (m.archived_at !== null) return false;
        if (m.project_id !== options.project_id) return false;
        const sinceMs = options.since.getTime();
        if (
          m.created_at.getTime() < sinceMs &&
          m.updated_at.getTime() < sinceMs
        )
          return false;
        if (options.exclude_self && m.author === options.user_id) return false;
        if (m.scope === "workspace" && m.workspace_id === options.workspace_id)
          return true;
        if (m.scope === "project") return true;
        if (m.scope === "user" && m.author === options.user_id) return true;
        return false;
      })
      .sort((a, b) => compareMemory(a, b, "updated_at", "desc"))
      .slice(0, options.limit);
  }

  // team_activity counts the caller's own changes — it's a
  // workspace-wide pulse, not a "since you were away" feed.
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
        m.archived_at === null,
    );
    let new_memories = 0;
    let updated_memories = 0;
    let commented_memories = 0;
    const sinceMs = since.getTime();
    for (const m of scoped) {
      if (m.created_at.getTime() > sinceMs) new_memories += 1;
      else if (
        m.created_at.getTime() < sinceMs &&
        m.updated_at.getTime() > sinceMs
      )
        updated_memories += 1;
      if (m.last_comment_at !== null && m.last_comment_at.getTime() > sinceMs)
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

  async search(options: SearchOptions): Promise<MemoryWithRelevance[]> {
    if (options.scope.length === 0) {
      throw new ValidationError("scope must contain at least one value");
    }
    for (const s of options.scope) {
      if (s === "user" && !options.user_id) {
        throw new ValidationError("user_id is required for user-scoped search");
      }
    }
    const hits = await this.cfg.index.search({
      embedding: options.embedding,
      projectId: options.project_id,
      workspaceId: options.workspace_id,
      scope: options.scope,
      userId: options.user_id ?? null,
      limit: options.limit ?? 10,
      minSimilarity: options.min_similarity ?? 0.3,
    });
    const out: MemoryWithRelevance[] = [];
    for (const h of hits) {
      const m = await this.findById(h.id);
      if (m !== null) out.push({ ...m, relevance: h.relevance });
    }
    return out;
  }

  async findDuplicates(
    options: Parameters<MemoryRepository["findDuplicates"]>[0],
  ): ReturnType<MemoryRepository["findDuplicates"]> {
    if (options.scope === "workspace" && !options.workspaceId) {
      throw new ValidationError(
        "workspaceId is required for workspace-scoped dedup",
      );
    }
    if (options.scope === "user" && !options.workspaceId) {
      throw new ValidationError(
        "workspaceId is required for user-scoped dedup",
      );
    }
    return await this.cfg.index.findDuplicates({
      embedding: options.embedding,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      scope: options.scope,
      userId: options.userId,
      threshold: options.threshold,
    });
  }

  async findPairwiseSimilar(
    options: Parameters<MemoryRepository["findPairwiseSimilar"]>[0],
  ): ReturnType<MemoryRepository["findPairwiseSimilar"]> {
    return await this.cfg.index.findPairwiseSimilar({
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      scope: options.scope,
      threshold: options.threshold,
    });
  }

  async listWithEmbeddings(
    options: Parameters<MemoryRepository["listWithEmbeddings"]>[0],
  ): ReturnType<MemoryRepository["listWithEmbeddings"]> {
    const rows = await this.cfg.index.listEmbeddings({
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      scope: options.scope,
      userId: options.userId ?? null,
      limit: options.limit,
    });
    const out: Array<Memory & { embedding: number[] }> = [];
    for (const r of rows) {
      const m = await this.findById(r.id);
      if (m !== null) out.push({ ...m, embedding: r.vector });
    }
    return out;
  }

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

  // Returns true when the given scope is tracked in git under the
  // current config. User-scope is only tracked when the caller opted
  // in via trackUsersInGit — otherwise users/ is gitignored and
  // stageAndCommit would throw "nothing to commit".
  #shouldCommit(scope: MemoryScope): boolean {
    return scope !== "user" || this.trackUsersInGit;
  }

  async #commit(
    rel: string,
    scope: MemoryScope,
    subject: string,
    trailer: CommitTrailer,
  ): Promise<void> {
    if (!this.#shouldCommit(scope)) return;
    try {
      await this.gitOps.stageAndCommit([rel], subject, trailer);
    } catch (err) {
      logger.warn("vault git commit failed; continuing", {
        rel,
        action: trailer.action,
        err,
      });
    }
  }
}

function locationFor(memory: Memory): MemoryLocation {
  return {
    id: memory.id,
    scope: memory.scope,
    workspaceId: memory.workspace_id,
    userId: memory.scope === "user" ? memory.author : null,
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

function validateListScope(o: ListOptions): void {
  if (o.scope.length === 0) {
    throw new ValidationError("scope must contain at least one value");
  }
  if (o.scope.includes("workspace") && !o.workspace_id) {
    throw new ValidationError(
      "workspace_id is required for workspace-scoped list",
    );
  }
  if (o.scope.includes("user") && !o.user_id) {
    throw new ValidationError("user_id is required for user-scoped list");
  }
}

// Mirror pg: scopes are OR-ed, and each scope has its own scope-column
// + id-column constraint. Project-scope ignores workspace_id entirely,
// so a workspace-scoped list that also includes project returns both.
function matchesList(m: Memory, o: ListOptions): boolean {
  if (m.archived_at !== null) return false;
  if (m.project_id !== o.project_id) return false;

  const scopeMatch = o.scope.some((s) => {
    if (s === "workspace")
      return m.scope === "workspace" && m.workspace_id === o.workspace_id;
    if (s === "project") return m.scope === "project";
    if (s === "user") return m.scope === "user" && m.author === o.user_id;
    return false;
  });
  if (!scopeMatch) return false;

  if (o.type !== undefined && m.type !== o.type) return false;
  if (o.tags !== undefined && o.tags.length > 0) {
    const haystack = new Set(m.tags ?? []);
    if (!o.tags.some((t) => haystack.has(t))) return false;
  }
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
  // Tiebreak on id for stable cursor paging.
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
