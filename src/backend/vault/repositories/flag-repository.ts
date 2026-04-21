import type { FlagRepository } from "../../../repositories/types.js";
import type { Flag, FlagResolution, FlagType } from "../../../types/flag.js";
import { NotFoundError } from "../../../utils/errors.js";
import { VaultMemoryFiles } from "./memory-files.js";
import { compareByCreatedAsc, compareByCreatedDesc } from "./util.js";

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
      next: { ...parsed, flags: [...parsed.flags, flag] },
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
    const all = await this.files.listAllParsed();
    const owner = all.find(({ parsed }) =>
      parsed.flags.some((f) => f.id === id && f.resolved_at === null),
    );
    if (!owner) return null;

    try {
      return await this.files.edit(owner.parsed.memory.id, (parsed) => {
        const idx = parsed.flags.findIndex(
          (f) => f.id === id && f.resolved_at === null,
        );
        // Owning memory still there but another writer resolved the flag first.
        if (idx < 0) return { next: parsed, result: null };
        const now = new Date();
        const current = parsed.flags[idx]!;
        const next: Flag =
          resolution === "deferred"
            ? { ...current, created_at: now }
            : { ...current, resolved_at: now, resolved_by: resolvedBy };
        const nextFlags = parsed.flags.slice();
        nextFlags[idx] = next;
        return { next: { ...parsed, flags: nextFlags }, result: next };
      });
    } catch (err) {
      // Owning memory archived between scan and lock → pg returns null here.
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async autoResolveByMemoryId(memoryId: string): Promise<number> {
    try {
      return await this.files.edit(memoryId, (parsed) => {
        const now = new Date();
        let count = 0;
        const nextFlags = parsed.flags.map((f) => {
          if (f.resolved_at !== null) return f;
          count += 1;
          return { ...f, resolved_at: now, resolved_by: "system" };
        });
        return { next: { ...parsed, flags: nextFlags }, result: count };
      });
    } catch (err) {
      if (err instanceof NotFoundError) return 0;
      throw err;
    }
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
