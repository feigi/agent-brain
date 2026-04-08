// D-17: Predefined memory types
export type MemoryType =
  | "fact"
  | "decision"
  | "learning"
  | "pattern"
  | "preference"
  | "architecture";

// D-08: Memory scopes
// workspace = scoped to a workspace, user = private, project = cross-workspace within deployment
export type MemoryScope = "workspace" | "user" | "project";

// D-37, D-62: Change type union for tracking what changed on a memory (used in list endpoints)
export type ChangeType = "created" | "updated" | "commented";

// Full memory object as stored (without embedding vector per D-44)
export interface Memory {
  id: string;
  project_id: string;
  workspace_id: string | null;
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
  flag_count: number; // computed via COUNT of open flags
  relationship_count: number; // computed via COUNT of active relationships
  last_comment_at: Date | null; // D-62: for change_type detection
  verified_by: string | null; // D-19: who verified
}

// Slim projection for list endpoints — omits internal/DB-only fields
export interface MemorySummary {
  id: string;
  title: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  tags: string[] | null;
  author: string;
  source: string | null;
  created_at: Date;
  updated_at: Date;
  verified_at: Date | null;
  verified_by: string | null;
  comment_count: number;
  flag_count: number;
  relationship_count: number;
  last_comment_at: Date | null;
}

// Full projection for detail endpoints — everything except embedding internals
export interface MemoryDetail extends MemorySummary {
  project_id: string;
  workspace_id: string | null;
  version: number;
  session_id: string | null;
  metadata: Record<string, unknown> | null;
  archived_at: Date | null;
}

/** Project a full Memory to the slim list representation */
export function toSummary(memory: Memory): MemorySummary {
  return {
    id: memory.id,
    title: memory.title,
    content: memory.content,
    type: memory.type,
    scope: memory.scope,
    tags: memory.tags,
    author: memory.author,
    source: memory.source,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    verified_at: memory.verified_at,
    verified_by: memory.verified_by,
    comment_count: memory.comment_count,
    flag_count: memory.flag_count,
    relationship_count: memory.relationship_count,
    last_comment_at: memory.last_comment_at,
  };
}

/** Project a full Memory to the detail representation (strips embedding internals) */
export function toDetail(memory: Memory): MemoryDetail {
  return {
    ...toSummary(memory),
    project_id: memory.project_id,
    workspace_id: memory.workspace_id,
    version: memory.version,
    session_id: memory.session_id,
    metadata: memory.metadata,
    archived_at: memory.archived_at,
  };
}

// Slim variants for list endpoints
// Slim list endpoint result with relevance score — used by search and session_start
export interface MemorySummaryWithRelevance extends MemorySummary {
  relevance: number;
}

// Slim list endpoint result with change classification — used by list_recent
export interface MemorySummaryWithChangeType extends MemorySummary {
  change_type: ChangeType;
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
export interface MemoryGetResponse extends MemoryDetail {
  comments: Comment[];
  flags: Array<{
    flag_id: string;
    flag_type: string;
    related_memory?: {
      id: string;
      title: string;
      content: string;
      scope: string;
    } | null;
    reason: string;
  }>;
  relationships: import("./relationship.js").RelationshipWithMemory[];
  can_comment: boolean;
  can_edit: boolean;
  can_archive: boolean;
  can_verify: boolean;
}

// Input type for creating a memory
export interface MemoryCreate {
  workspace_id?: string; // optional for project-scoped memories (cross-workspace)
  content: string;
  title?: string; // D-03: auto-generate from content if omitted
  type: MemoryType;
  scope?: MemoryScope; // defaults to "workspace"
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
