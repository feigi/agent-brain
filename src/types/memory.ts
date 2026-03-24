// D-17: Predefined memory types
export type MemoryType =
  | "fact"
  | "decision"
  | "learning"
  | "pattern"
  | "preference"
  | "architecture";

// D-08: Memory scopes
export type MemoryScope = "project" | "user";

// Full memory object as stored (without embedding vector per D-44)
export interface Memory {
  id: string;
  project_id: string;
  content: string;
  title: string;
  type: MemoryType;
  scope: MemoryScope;
  tags: string[] | null;
  author: string;
  source: string | null;
  session_id: string | null;
  metadata: Record<string, unknown> | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  verified_at: Date | null;
  archived_at: Date | null;
  comment_count: number; // D-61: computed via COUNT, present on all responses
  last_comment_at: Date | null; // D-62: for change_type detection
  verified_by: string | null; // D-19: who verified
}

// D-47: Comment on a memory by a team member
export interface Comment {
  id: string;
  memory_id: string;
  author: string;
  content: string;
  created_at: Date;
}

// D-72, D-63: Enhanced response for memory_get with comments and capability flags
export interface MemoryGetResponse extends Memory {
  comments: Comment[];
  can_comment: boolean;
  can_edit: boolean;
  can_archive: boolean;
  can_verify: boolean;
}

// D-37: Memory with change type for memory_list_recent
export interface MemoryWithChangeType extends Memory {
  change_type: "created" | "updated" | "commented";
}

// Input type for creating a memory
export interface MemoryCreate {
  project_id: string;
  content: string;
  title?: string; // D-03: auto-generate from content if omitted
  type: MemoryType;
  scope?: MemoryScope; // defaults to "project"
  tags?: string[];
  author: string; // D-25, D-38: required for provenance
  source?: string; // D-23: manual, agent-auto, session-review, etc.
  session_id?: string; // D-24
  metadata?: Record<string, unknown>; // D-26
}

// Input type for updating a memory (D-09: partial/PATCH-style)
export interface MemoryUpdate {
  content?: string;
  title?: string;
  type?: MemoryType;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// D-05, D-06: Search result with relevance score (renamed from MemoryWithScore/similarity)
export interface MemoryWithRelevance extends Memory {
  relevance: number;
}

// Phase 4: Discriminated union result for autonomous memory_create (budget or dedup skip)
export interface CreateSkipResult {
  skipped: true;
  reason: "budget_exceeded" | "duplicate";
  message: string;
  duplicate?: { id: string; title: string; relevance: number; scope?: string };
}
