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
  type: RelationshipType;
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

// Wire-facing subset; nullable DB fields become optional to match the
// null-stripping JSON replacer at the response boundary.
export interface RelationshipSummary {
  id: string;
  type: RelationshipType;
  description?: string;
  confidence: number;
  source_id: string;
  target_id: string;
}

export interface RelationshipWithMemory {
  id: string;
  source_id: string;
  target_id: string;
  type: RelationshipType;
  description?: string;
  confidence: number;
  created_by: string;
  created_via?: string;
  created_at: Date;
  direction: "outgoing" | "incoming";
  /** In listForMemory: the memory on the opposite end from the queried one.
   *  In listBetweenMemories: always the target memory (source→target canonical direction). */
  related_memory: RelatedMemorySummary;
}
