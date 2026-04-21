import type { FlagRepository } from "../../../repositories/types.js";
import type { Flag, FlagResolution, FlagType } from "../../../types/flag.js";
import { VaultMemoryFiles } from "./memory-files.js";

export interface VaultFlagConfig {
  root: string;
}

export class VaultFlagRepository implements FlagRepository {
  private readonly files: VaultMemoryFiles;

  constructor(cfg: VaultFlagConfig) {
    this.files = new VaultMemoryFiles({ root: cfg.root });
  }

  async create(flag: Flag): Promise<Flag> {
    return await this.files.edit(flag.memory_id, (parsed) => ({
      parsed: { ...parsed, flags: [...parsed.flags, flag] },
      result: flag,
    }));
  }

  async findByMemoryId(memoryId: string): Promise<Flag[]> {
    const parsed = await this.files.read(memoryId);
    if (!parsed) return [];
    return [...parsed.flags].sort(compareByCreatedDesc);
  }

  async findByMemoryIds(memoryIds: string[]): Promise<Flag[]> {
    if (memoryIds.length === 0) return [];
    const out: Flag[] = [];
    for (const id of memoryIds) {
      const parsed = await this.files.read(id);
      if (!parsed) continue;
      out.push(...parsed.flags);
    }
    return out.sort(compareByCreatedDesc);
  }

  // Mirrors DrizzleFlagRepository.findOpenByWorkspace: needs_review flags
  // with resolved_at=null on memories that are either in workspaceId or
  // project-scoped, ordered by created_at asc.
  async findOpenByWorkspace(
    projectId: string,
    workspaceId: string,
    limit: number,
  ): Promise<Flag[]> {
    const all = await this.files.listAllParsed();
    const out: Flag[] = [];
    for (const { parsed } of all) {
      const m = parsed.memory;
      if (m.project_id !== projectId) continue;
      if (!(m.workspace_id === workspaceId || m.scope === "project")) continue;
      for (const f of parsed.flags) {
        if (f.severity === "needs_review" && f.resolved_at === null)
          out.push(f);
      }
    }
    return out.sort(compareByCreatedAsc).slice(0, limit);
  }

  async resolve(
    id: string,
    resolvedBy: string,
    resolution: FlagResolution,
  ): Promise<Flag | null> {
    // Scan to find the memory that owns this flag (and only if unresolved,
    // mirroring pg's WHERE id=? AND resolved_at IS NULL).
    const all = await this.files.listAllParsed();
    const owner = all.find(({ parsed }) =>
      parsed.flags.some((f) => f.id === id && f.resolved_at === null),
    );
    if (!owner) return null;

    return await this.files.edit(owner.parsed.memory.id, (parsed) => {
      const idx = parsed.flags.findIndex(
        (f) => f.id === id && f.resolved_at === null,
      );
      if (idx < 0) return { parsed, result: null }; // lost race under lock
      const now = new Date();
      const current = parsed.flags[idx]!;
      const next: Flag =
        resolution === "deferred"
          ? { ...current, created_at: now }
          : { ...current, resolved_at: now, resolved_by: resolvedBy };
      const nextFlags = parsed.flags.slice();
      nextFlags[idx] = next;
      return { parsed: { ...parsed, flags: nextFlags }, result: next };
    });
  }

  async autoResolveByMemoryId(memoryId: string): Promise<number> {
    // pg returns 0 when the memory has no unresolved flags (or doesn't
    // exist — FKs make flag rows impossible without the memory).
    const rel = await this.files.resolvePath(memoryId);
    if (rel === null) return 0;
    return await this.files.edit(memoryId, (parsed) => {
      const now = new Date();
      let count = 0;
      const nextFlags = parsed.flags.map((f) => {
        if (f.resolved_at !== null) return f;
        count += 1;
        return { ...f, resolved_at: now, resolved_by: "system" };
      });
      return { parsed: { ...parsed, flags: nextFlags }, result: count };
    });
  }

  async hasOpenFlag(
    memoryId: string,
    flagType: FlagType,
    relatedMemoryId?: string,
  ): Promise<boolean> {
    const parsed = await this.files.read(memoryId);
    if (!parsed) return false;
    return parsed.flags.some(
      (f) =>
        f.flag_type === flagType &&
        f.resolved_at === null &&
        (relatedMemoryId === undefined ||
          f.details.related_memory_id === relatedMemoryId),
    );
  }
}

function compareByCreatedAsc(a: Flag, b: Flag): number {
  return a.created_at.getTime() - b.created_at.getTime();
}

function compareByCreatedDesc(a: Flag, b: Flag): number {
  return b.created_at.getTime() - a.created_at.getTime();
}
