import type { RelationshipSummary } from "./relationship.js";
import type { FlagResponse } from "./flag.js";
import type { BackendSessionStartMeta } from "../backend/types.js";

// D-02: Envelope response structure
export interface Envelope<T> {
  data: T;
  meta: EnvelopeMeta;
}

export type EnvelopeMeta = EnvelopeCoreMeta & BackendSessionStartMeta;

interface EnvelopeCoreMeta {
  count?: number;
  timing?: number; // ms
  cursor?: string;
  has_more?: boolean;
  team_activity?: {
    // D-29: session_start only
    new_memories: number;
    updated_memories: number;
    commented_memories: number;
    since: string; // ISO timestamp
  };
  comment_count?: number; // D-67: memory_comment response
  session_id?: string; // returned from session_start
  budget?: {
    // returned from memory_create for autonomous writes
    used: number;
    limit: number;
    exceeded: boolean;
  };
  flags?: FlagResponse[];
  relationships?: RelationshipSummary[];
  omitted?: string[]; // IDs requested but not returned (inaccessible/not found)
  project_truncated?: boolean; // session_start only: true when project-scoped memories exceeded project_limit
  project_scope_status?: "ok" | "failed"; // session_start only: "failed" when listProjectScoped threw and ranked results were returned without project-scoped memories
  index_truncated_count?: number; // session_start only: count of index rows dropped to fit preview budget
}
