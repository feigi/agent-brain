import type { Memory, MemoryWithRelevance, Comment } from "../types/memory.js";

// INFR-02: Repository interfaces -- abstract storage layer

export interface ListOptions {
  project_id: string;
  scope: "project" | "user";
  user_id?: string;
  type?: string;
  tags?: string[];
  sort_by?: "created_at" | "updated_at";
  order?: "asc" | "desc";
  cursor?: { created_at: string; id: string };
  limit?: number;
}

export interface SearchOptions {
  embedding: number[];
  project_id: string;
  scope: "project" | "user" | "both"; // D-08: 'both' for cross-scope search
  user_id?: string;
  limit?: number;
  min_similarity?: number;
}

export interface RecentBothScopesOptions {
  project_id: string;
  user_id: string;
  limit: number;
}

export interface StaleOptions {
  project_id: string;
  threshold_days: number;
  limit?: number;
  cursor?: { created_at: string; id: string };
}

export interface MemoryRepository {
  create(memory: Memory & { embedding: number[] }): Promise<Memory>;
  findById(id: string): Promise<Memory | null>;
  update(
    id: string,
    expectedVersion: number,
    updates: Partial<Memory> & { embedding?: number[] | null },
  ): Promise<Memory>;
  archive(ids: string[]): Promise<number>;
  search(options: SearchOptions): Promise<MemoryWithRelevance[]>;
  list(options: ListOptions): Promise<{
    memories: Memory[];
    has_more: boolean;
    cursor?: { created_at: string; id: string };
  }>;
  findStale(options: StaleOptions): Promise<{
    memories: Memory[];
    has_more: boolean;
    cursor?: { created_at: string; id: string };
  }>;
  listRecentBothScopes(options: RecentBothScopesOptions): Promise<Memory[]>;
  verify(id: string, verifiedBy: string): Promise<Memory | null>;
  findRecentActivity(options: RecentActivityOptions): Promise<Memory[]>;
  countTeamActivity(
    projectId: string,
    userId: string,
    since: Date,
  ): Promise<TeamActivityCounts>;
  findDuplicates(options: {
    embedding: number[];
    projectId: string;
    scope: "project" | "user";
    userId: string;
    threshold: number;
  }): Promise<
    Array<{ id: string; title: string; relevance: number; scope: string }>
  >;
}

export interface ProjectRepository {
  findOrCreate(slug: string): Promise<{ id: string; created_at: Date }>;
  findById(slug: string): Promise<{ id: string; created_at: Date } | null>;
}

export interface CommentRepository {
  create(comment: {
    id: string;
    memory_id: string;
    author: string;
    content: string;
  }): Promise<Comment>;
  findByMemoryId(memoryId: string): Promise<Comment[]>;
  countByMemoryId(memoryId: string): Promise<number>;
}

export interface SessionTrackingRepository {
  upsert(userId: string, projectId: string): Promise<Date | null>; // returns previous last_session_at or null
}

// Phase 4: Session lifecycle repository for autonomous write budget tracking
export interface SessionRepository {
  createSession(id: string, userId: string, projectId: string): Promise<void>;
  getBudget(sessionId: string): Promise<{ used: number; limit: number } | null>;
  incrementBudgetUsed(
    sessionId: string,
    limit: number,
  ): Promise<{ used: number; exceeded: boolean }>;
  findById(sessionId: string): Promise<{
    id: string;
    user_id: string;
    project_id: string;
    budget_used: number;
  } | null>;
}

export interface RecentActivityOptions {
  project_id: string;
  user_id: string;
  since: Date;
  limit: number;
  exclude_self: boolean;
}

export interface TeamActivityCounts {
  new_memories: number;
  updated_memories: number;
  commented_memories: number;
}
