import { parseMemoryFile, serializeMemoryFile } from "./memory-parser.js";
import type { ParsedMemoryFile } from "./memory-parser.js";
import type { Memory } from "../../../types/memory.js";

export type MergeResult =
  | { ok: true; merged: string }
  | { ok: false; reason: string };

export type Diff3Result = { clean: true; text: string } | { clean: false };

export interface MergeOptions {
  /**
   * Three-way diff over body text. Called with (base, ours, theirs) as
   * raw strings. Returns the clean merged text or { clean: false } on
   * unresolvable conflict, in which case the caller falls back to LWW.
   */
  diff3: (
    base: string,
    ours: string,
    theirs: string,
  ) => Promise<Diff3Result> | Diff3Result;
}

export async function mergeMemoryFiles(
  ancestor: string,
  ours: string,
  theirs: string,
  opts: MergeOptions,
): Promise<MergeResult> {
  let a: ParsedMemoryFile, o: ParsedMemoryFile, t: ParsedMemoryFile;
  try {
    a = parseMemoryFile(ancestor);
    o = parseMemoryFile(ours);
    t = parseMemoryFile(theirs);
  } catch (err) {
    return { ok: false, reason: `parse: ${(err as Error).message}` };
  }

  // Immutable fields — bail if ours/theirs disagree.
  for (const field of ["id", "project_id"] as const) {
    if (o.memory[field] !== t.memory[field]) {
      return { ok: false, reason: `immutable field diverged: ${field}` };
    }
  }
  if (o.memory.created_at.getTime() !== t.memory.created_at.getTime()) {
    return { ok: false, reason: "immutable field diverged: created_at" };
  }

  // Determine which side is "later" for LWW resolution.
  const oTime = o.memory.updated_at.getTime();
  const tTime = t.memory.updated_at.getTime();
  const later = oTime >= tTime ? o : t;

  // Body content via diff3, LWW fallback.
  const bodyResult = await opts.diff3(
    a.memory.content,
    o.memory.content,
    t.memory.content,
  );
  const mergedContent = bodyResult.clean
    ? bodyResult.text
    : later.memory.content;

  // verified_at/verified_by: take the pair with the later verified_at.
  const { verified_at: mergedVerifiedAt, verified_by: mergedVerifiedBy } =
    mergeVerified(
      o.memory.verified_at,
      o.memory.verified_by,
      t.memory.verified_at,
      t.memory.verified_by,
    );

  const mergedMemory: Memory = {
    // Start from the later side for all LWW fields.
    ...later.memory, // version: LWW from later side; post-merge bump is caller's responsibility
    // Body text (three-way or LWW fallback).
    content: mergedContent,
    // updated_at is always max of both sides.
    updated_at: new Date(Math.max(oTime, tTime)),
    // archived_at is sticky: once set, never unset (take max non-null).
    archived_at: maxDate(o.memory.archived_at, t.memory.archived_at),
    // verified pair.
    verified_at: mergedVerifiedAt,
    verified_by: mergedVerifiedBy,
    // tags: union (sorted for determinism).
    tags: unionSorted(o.memory.tags, t.memory.tags),
    // metadata: per-key LWW — later side wins per key, missing keys from
    // earlier side are filled in.
    metadata: mergeMetadata(
      o.memory.metadata,
      t.memory.metadata,
      oTime >= tTime,
    ),
    // Derived counts are recomputed below from the merged body sections.
    flag_count: 0,
    comment_count: 0,
    relationship_count: 0,
    last_comment_at: null,
  };

  // Body sub-sections: union by stable key.
  // Collision policy: 'theirs wins' (b overwrites a in unionBy).
  // NOTE: This is NOT LWW-by-updated_at. Neither Flag nor Relationship carries
  // an updated_at field — both have only created_at. Until the schema is
  // extended with an update timestamp, deterministic 'theirs wins' is the best
  // we can do without risking silent data loss. Collisions are rare in practice
  // since these sections are append-only from each clone.
  const comments = unionBy(o.comments, t.comments, (c) => c.id).sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
  );
  const flags = unionBy(o.flags, t.flags, (f) => f.id);
  const relationships = unionBy(
    o.relationships,
    t.relationships,
    (r) => `${r.source_id}|${r.target_id}|${r.type}`,
  );

  const out: ParsedMemoryFile = {
    memory: {
      ...mergedMemory,
      flag_count: flags.filter((f) => f.resolved_at === null).length,
      comment_count: comments.length,
      relationship_count: relationships.length,
      last_comment_at:
        comments.length === 0
          ? null
          : new Date(Math.max(...comments.map((c) => c.created_at.getTime()))),
    },
    flags,
    comments,
    relationships,
  };

  return { ok: true, merged: serializeMemoryFile(out) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Pick the verified_at/verified_by pair with the later verified_at.
 * If one side is null and the other is not, take the non-null side.
 * If both are null, result is null/null.
 */
function mergeVerified(
  oVerifiedAt: Date | null,
  oVerifiedBy: string | null,
  tVerifiedAt: Date | null,
  tVerifiedBy: string | null,
): { verified_at: Date | null; verified_by: string | null } {
  if (oVerifiedAt === null && tVerifiedAt === null) {
    return { verified_at: null, verified_by: null };
  }
  if (oVerifiedAt === null) {
    return { verified_at: tVerifiedAt, verified_by: tVerifiedBy };
  }
  if (tVerifiedAt === null) {
    return { verified_at: oVerifiedAt, verified_by: oVerifiedBy };
  }
  // Both non-null: pick the later one.
  if (oVerifiedAt.getTime() >= tVerifiedAt.getTime()) {
    return { verified_at: oVerifiedAt, verified_by: oVerifiedBy };
  }
  return { verified_at: tVerifiedAt, verified_by: tVerifiedBy };
}

/**
 * Union of two nullable tag arrays. Returns null only when both inputs are null.
 * Result is sorted for determinism.
 */
function unionSorted(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null && b === null) return null;
  const set = new Set<string>([...(a ?? []), ...(b ?? [])]);
  return Array.from(set).sort();
}

/**
 * Per-key LWW merge of metadata objects.
 * The "later" side wins on key collisions; keys present only on the
 * earlier side are included (union of keys).
 */
function mergeMetadata(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
  aIsLater: boolean,
): Record<string, unknown> | null {
  if (a === null && b === null) return null;
  const winner = aIsLater ? a : b;
  const loser = aIsLater ? b : a;
  const out: Record<string, unknown> = { ...(loser ?? {}) };
  if (winner !== null) {
    for (const [k, v] of Object.entries(winner)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Union two arrays by a stable key function. When both sides have an
 * entry for the same key, the entry from `b` (theirs) takes precedence —
 * consistent with "later side wins" for append-only sections.
 */
function unionBy<T>(a: T[], b: T[], key: (x: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const x of a) seen.set(key(x), x);
  for (const x of b) seen.set(key(x), x); // b overwrites on collision
  return Array.from(seen.values());
}
