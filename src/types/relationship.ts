import type { MemoryType, MemoryScope } from "./memory.js";

export const WELL_KNOWN_RELATIONSHIP_TYPES = [
  "overrides",
  "implements",
  "refines",
  "contradicts",
  "duplicates",
] as const;

export type WellKnownRelationshipType =
  (typeof WELL_KNOWN_RELATIONSHIP_TYPES)[number];

export type RelationshipType = WellKnownRelationshipType | (string & {});

export interface CreateRelationshipInput {
  sourceId: string;
  targetId: string;
  type: string;
  description?: string;
  /** Value between 0 and 1 inclusive */
  confidence?: number;
  userId: string;
  createdVia?: string;
}

export interface Relationship {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  /** Well-known types: overrides, implements, refines, contradicts, duplicates. Any string is valid. */
  type: RelationshipType;
  description: string | null;
  /** Value between 0 and 1 inclusive */
  confidence: number;
  created_by: string;
  created_via: string | null;
  archived_at: Date | null;
  created_at: Date;
}

/** Summary of the related memory, included when returning relationships */
export interface RelatedMemorySummary {
  id: string;
  title: string;
  type: MemoryType;
  scope: MemoryScope;
}

/** Subset of Relationship fields for lightweight API responses (e.g. session_start meta) */
export type RelationshipSummary = Pick<
  Relationship,
  "id" | "type" | "description" | "confidence" | "source_id" | "target_id"
>;

/** Relationship enriched with related memory summary for API responses */
export interface RelationshipWithMemory extends Omit<
  Relationship,
  "project_id" | "archived_at"
> {
  direction: "outgoing" | "incoming";
  /** In listForMemory: the memory on the opposite end from the queried one.
   *  In listBetweenMemories: always the target memory (source→target canonical direction). */
  related_memory: RelatedMemorySummary;
}
