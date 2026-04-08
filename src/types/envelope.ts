import type { RelationshipSummary } from "./relationship.js";

// D-02: Envelope response structure
export interface Envelope<T> {
  data: T;
  meta: {
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
    session_id?: string; // Phase 4: returned from session_start
    budget?: {
      // Phase 4: returned from memory_create for autonomous writes
      used: number;
      limit: number;
      exceeded: boolean;
    };
    flags?: Array<{
      flag_id: string;
      flag_type: string;
      memory: { id: string; title: string; content: string; scope: string };
      related_memory?: {
        id: string;
        title: string;
        content: string;
        scope: string;
      } | null;
      reason: string;
    }>;
    relationships?: RelationshipSummary[];
    omitted?: string[]; // IDs requested but not returned (inaccessible/not found)
  };
}
