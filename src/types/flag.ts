export type FlagType =
  | "duplicate"
  | "contradiction"
  | "override"
  | "superseded"
  | "verify";

export type FlagSeverity = "auto_resolved" | "needs_review";

export type FlagResolution = "accepted" | "dismissed" | "deferred";

export interface Flag {
  id: string;
  project_id: string;
  memory_id: string;
  flag_type: FlagType;
  severity: FlagSeverity;
  details: {
    related_memory_id?: string;
    relationship_id?: string;
    similarity?: number;
    reason: string;
  };
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Date;
}

export interface FlagWithMemory extends Flag {
  memory: {
    id: string;
    title: string;
    content: string;
    scope: import("./memory.js").MemoryScope;
  };
  related_memory?: {
    id: string;
    title: string;
    content: string;
    scope: import("./memory.js").MemoryScope;
  } | null;
}

/** Enriched flag for API responses (session_start, consolidate, memory_get). */
export interface FlagResponse {
  flag_id: string;
  flag_type: FlagType;
  memory: {
    id: string;
    title: string;
    content: string;
    scope: import("./memory.js").MemoryScope;
  };
  related_memory?: {
    id: string;
    title: string;
    content: string;
    scope: import("./memory.js").MemoryScope;
  } | null;
  reason: string;
}
