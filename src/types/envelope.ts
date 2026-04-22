import type { RelationshipSummary } from "./relationship.js";
import type { FlagResponse } from "./flag.js";

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
    flags?: FlagResponse[];
    relationships?: RelationshipSummary[];
    omitted?: string[]; // IDs requested but not returned (inaccessible/not found)
    project_truncated?: boolean; // session_start only: true when project-scoped memories exceeded project_limit
    project_scope_status?: "ok" | "failed"; // session_start only: "failed" when listProjectScoped threw and ranked results were returned without project-scoped memories
    /** session_start only: backend is offline (vault: no network / git pull skipped) */
    offline?: true;
    /** session_start only: number of local commits not yet pushed to remote */
    unpushed_commits?: number;
    /** session_start only: a git rebase conflict was detected during pull */
    pull_conflict?: true;
    /** session_start only: number of vault YAML files that failed to parse */
    parse_errors?: number;
  };
}
