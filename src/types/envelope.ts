// D-02: Envelope response structure
export interface Envelope<T> {
  data: T;
  meta: {
    count?: number;
    timing?: number;  // ms
    cursor?: string;
    has_more?: boolean;
    team_activity?: {           // D-29: session_start only
      new_memories: number;
      updated_memories: number;
      commented_memories: number;
      since: string;            // ISO timestamp
    };
    comment_count?: number;     // D-67: memory_comment response
  };
}
