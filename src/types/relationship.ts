export const WELL_KNOWN_RELATIONSHIP_TYPES = [
  "overrides",
  "implements",
  "refines",
  "contradicts",
  "duplicates",
] as const;

export type WellKnownRelationshipType =
  (typeof WELL_KNOWN_RELATIONSHIP_TYPES)[number];

export interface Relationship {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  type: string;
  description: string | null;
  confidence: number;
  created_by: string;
  source: string | null;
  archived_at: Date | null;
  created_at: Date;
}

/** Summary of the related memory, included when returning relationships */
export interface RelatedMemorySummary {
  id: string;
  title: string;
  type: string;
  scope: string;
}

/** Relationship enriched with related memory summary for API responses */
export interface RelationshipWithMemory {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  description: string | null;
  confidence: number;
  created_by: string;
  source: string | null;
  direction: "outgoing" | "incoming";
  related_memory: RelatedMemorySummary;
  created_at: Date;
}
