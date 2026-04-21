import type { RelationshipRepository } from "../../../repositories/types.js";
import type { Relationship } from "../../../types/relationship.js";
import { VaultMemoryFiles } from "./memory-files.js";

export interface VaultRelationshipConfig {
  root: string;
}

// Relationships are stored in the source memory's markdown file under
// `## Relationships`. Archive is implemented as line removal — pg keeps
// a tombstone via `archived_at` but every public method filters on
// `isNull(archived_at)`, so the observable behavior is identical.
// Incoming-direction queries (and findById, findExisting) scan all
// memory files; cost is O(N * avg-rel-count) and accepted at Phase 2 scale.
export class VaultRelationshipRepository implements RelationshipRepository {
  private readonly files: VaultMemoryFiles;

  constructor(cfg: VaultRelationshipConfig) {
    this.files = new VaultMemoryFiles({ root: cfg.root });
  }

  async create(relationship: Relationship): Promise<Relationship> {
    // Stored in the source memory's file. `archived_at` is dropped
    // because the parser always reads it as null (archive = delete).
    const persisted: Relationship = { ...relationship, archived_at: null };
    return await this.files.edit(persisted.source_id, (parsed) => ({
      parsed: {
        ...parsed,
        relationships: [...parsed.relationships, persisted],
      },
      result: persisted,
    }));
  }

  async findById(id: string): Promise<Relationship | null> {
    const all = await this.files.listAllParsed();
    for (const { parsed } of all) {
      const hit = parsed.relationships.find((r) => r.id === id);
      if (hit) return hit;
    }
    return null;
  }

  async findByMemoryId(
    projectId: string,
    memoryId: string,
    direction: "outgoing" | "incoming" | "both",
    type?: string,
  ): Promise<Relationship[]> {
    const out: Relationship[] = [];

    if (direction === "outgoing" || direction === "both") {
      const parsed = await this.files.read(memoryId);
      if (parsed && parsed.memory.project_id === projectId) {
        for (const r of parsed.relationships) {
          if (type !== undefined && r.type !== type) continue;
          out.push(r);
        }
      }
    }

    if (direction === "incoming" || direction === "both") {
      const all = await this.files.listAllParsed();
      for (const { parsed } of all) {
        if (parsed.memory.id === memoryId) continue;
        if (parsed.memory.project_id !== projectId) continue;
        for (const r of parsed.relationships) {
          if (r.target_id !== memoryId) continue;
          if (type !== undefined && r.type !== type) continue;
          out.push(r);
        }
      }
    }

    return out.sort(compareByCreatedAsc);
  }

  async findByMemoryIds(
    projectId: string,
    memoryIds: string[],
    direction: "outgoing" | "incoming" | "both",
    type?: string,
  ): Promise<Relationship[]> {
    if (memoryIds.length === 0) return [];
    const ids = new Set(memoryIds);
    const out: Relationship[] = [];
    const all = await this.files.listAllParsed();

    for (const { parsed } of all) {
      if (parsed.memory.project_id !== projectId) continue;
      const m = parsed.memory;
      for (const r of parsed.relationships) {
        if (type !== undefined && r.type !== type) continue;
        const srcHit = ids.has(m.id); // r.source_id === m.id by storage layout
        const tgtHit = ids.has(r.target_id);
        const keep =
          direction === "outgoing"
            ? srcHit
            : direction === "incoming"
              ? tgtHit
              : srcHit || tgtHit;
        if (keep) out.push(r);
      }
    }

    return out.sort(compareByCreatedAsc);
  }

  async findExisting(
    projectId: string,
    sourceId: string,
    targetId: string,
    type: string,
  ): Promise<Relationship | null> {
    const parsed = await this.files.read(sourceId);
    if (!parsed) return null;
    if (parsed.memory.project_id !== projectId) return null;
    return (
      parsed.relationships.find(
        (r) => r.target_id === targetId && r.type === type,
      ) ?? null
    );
  }

  async findBetweenMemories(
    projectId: string,
    memoryIds: string[],
  ): Promise<Relationship[]> {
    if (memoryIds.length < 2) return [];
    const ids = new Set(memoryIds);
    const out: Relationship[] = [];
    for (const id of memoryIds) {
      const parsed = await this.files.read(id);
      if (!parsed) continue;
      if (parsed.memory.project_id !== projectId) continue;
      for (const r of parsed.relationships) {
        if (ids.has(r.target_id)) out.push(r);
      }
    }
    return out.sort(compareByCreatedAsc);
  }

  async archiveByMemoryId(
    memoryId: string,
    projectId: string,
  ): Promise<number> {
    let count = 0;

    // Outgoing: wipe relationships stored in memoryId's own file.
    const rel = await this.files.resolvePath(memoryId);
    if (rel !== null) {
      await this.files.edit(memoryId, (parsed) => {
        if (parsed.memory.project_id !== projectId) {
          return { parsed, result: null };
        }
        count += parsed.relationships.length;
        return { parsed: { ...parsed, relationships: [] }, result: null };
      });
    }

    // Incoming: scan other memories and drop lines pointing at memoryId.
    const all = await this.files.listAllParsed();
    for (const { parsed } of all) {
      if (parsed.memory.id === memoryId) continue;
      if (parsed.memory.project_id !== projectId) continue;
      const hits = parsed.relationships.filter((r) => r.target_id === memoryId);
      if (hits.length === 0) continue;
      await this.files.edit(parsed.memory.id, (p) => {
        const next = p.relationships.filter((r) => r.target_id !== memoryId);
        count += p.relationships.length - next.length;
        return { parsed: { ...p, relationships: next }, result: null };
      });
    }

    return count;
  }

  async archiveById(id: string): Promise<boolean> {
    const all = await this.files.listAllParsed();
    const owner = all.find(({ parsed }) =>
      parsed.relationships.some((r) => r.id === id),
    );
    if (!owner) return false;
    return await this.files.edit(owner.parsed.memory.id, (parsed) => {
      const before = parsed.relationships.length;
      const next = parsed.relationships.filter((r) => r.id !== id);
      return {
        parsed: { ...parsed, relationships: next },
        result: next.length < before,
      };
    });
  }
}

function compareByCreatedAsc(a: Relationship, b: Relationship): number {
  return a.created_at.getTime() - b.created_at.getTime();
}
