// D-17: Predefined memory types
export type MemoryType = "fact" | "decision" | "learning" | "pattern" | "preference" | "architecture";

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
}

// Input type for creating a memory
export interface MemoryCreate {
  project_id: string;
  content: string;
  title?: string;          // D-03: auto-generate from content if omitted
  type: MemoryType;
  scope?: MemoryScope;     // defaults to "project"
  tags?: string[];
  author: string;          // D-25, D-38: required for provenance
  source?: string;         // D-23: manual, agent-auto, session-review, etc.
  session_id?: string;     // D-24
  metadata?: Record<string, unknown>;  // D-26
}

// Input type for updating a memory (D-09: partial/PATCH-style)
export interface MemoryUpdate {
  content?: string;
  title?: string;
  type?: MemoryType;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// D-43: Search result includes similarity score
export interface MemoryWithScore extends Memory {
  similarity: number;
}
