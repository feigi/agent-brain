import type {
  Memory,
  MemoryScope,
  MemoryWithRelevance,
  Comment,
} from "../types/memory.js";
import type { AuditEntry } from "../types/audit.js";
import type { Flag, FlagResolution, FlagType } from "../types/flag.js";
import type { Relationship } from "../types/relationship.js";

// INFR-02: Repository interfaces -- abstract storage layer

export interface ListOptions {
  project_id: string; // deployment project (from server config)
  workspace_id?: string; // optional for project-scope listing (cross-workspace)
  scope: MemoryScope[]; // non-empty; project-scoped memories are auto-included when any non-project scope is requested
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
  project_id: string; // deployment project
  workspace_id: string; // workspace to search within
  scope: MemoryScope[]; // non-empty; project-scoped memories are auto-included when any non-project scope is requested
  user_id?: string;
  limit?: number;
  min_similarity?: number;
}

export interface RecentBothScopesOptions {
  project_id: string; // deployment project
  workspace_id: string;
  user_id: string;
  limit: number;
}

export interface StaleOptions {
  project_id: string; // deployment project
  workspace_id: string;
  threshold_days: number;
  limit?: number;
  cursor?: { created_at: string; id: string };
}

export interface MemoryRepository {
  create(memory: Memory & { embedding: number[] }): Promise<Memory>;
  findById(id: string): Promise<Memory | null>;
  findByIdIncludingArchived(id: string): Promise<Memory | null>;
  findByIds(ids: string[]): Promise<Memory[]>;
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
    workspaceId: string,
    userId: string,
    since: Date,
  ): Promise<TeamActivityCounts>;
  findDuplicates(options: {
    embedding: number[];
    projectId: string;
    workspaceId: string | null;
    scope: MemoryScope;
    userId: string;
    threshold: number;
  }): Promise<
    Array<{
      id: string;
      title: string;
      relevance: number;
      scope: MemoryScope;
    }>
  >;

  findPairwiseSimilar(options: {
    projectId: string;
    workspaceId: string | null;
    scope: "workspace" | "project";
    threshold: number;
  }): Promise<
    Array<{
      memory_a_id: string;
      memory_b_id: string;
      similarity: number;
    }>
  >;

  listDistinctWorkspaces(projectId: string): Promise<string[]>;

  listWithEmbeddings(options: {
    projectId: string;
    workspaceId: string | null;
    scope: MemoryScope;
    userId?: string;
    limit: number;
  }): Promise<Array<Memory & { embedding: number[] }>>;
}

export interface WorkspaceRepository {
  findOrCreate(slug: string): Promise<{ id: string; created_at: Date }>;
  findById(slug: string): Promise<{ id: string; created_at: Date } | null>;
}

export interface AuditRepository {
  create(entry: AuditEntry): Promise<void>;
  findByMemoryId(memoryId: string): Promise<AuditEntry[]>;
}

export interface CommentRepository {
  create(comment: {
    id: string;
    memory_id: string;
    author: string;
    content: string;
  }): Promise<Comment>;
  findByMemoryId(memoryId: string): Promise<Comment[]>;
  findByMemoryIds(memoryIds: string[]): Promise<Comment[]>;
  countByMemoryId(memoryId: string): Promise<number>;
}

export interface SessionTrackingRepository {
  upsert(
    userId: string,
    projectId: string,
    workspaceId: string,
  ): Promise<Date | null>;
}

// Phase 4: Session lifecycle repository for autonomous write budget tracking
export interface SessionRepository {
  createSession(
    id: string,
    userId: string,
    projectId: string,
    workspaceId: string,
  ): Promise<void>;
  getBudget(sessionId: string): Promise<{ used: number; limit: number } | null>;
  incrementBudgetUsed(
    sessionId: string,
    limit: number,
  ): Promise<{ used: number; exceeded: boolean }>;
  findById(sessionId: string): Promise<{
    id: string;
    user_id: string;
    project_id: string;
    workspace_id: string;
    budget_used: number;
  } | null>;
}

export interface FlagRepository {
  create(flag: Flag): Promise<Flag>;
  findOpenByWorkspace(
    projectId: string,
    workspaceId: string,
    limit: number,
  ): Promise<Flag[]>;
  resolve(
    id: string,
    resolvedBy: string,
    resolution: FlagResolution,
  ): Promise<Flag | null>;
  findByMemoryId(memoryId: string): Promise<Flag[]>;
  findByMemoryIds(memoryIds: string[]): Promise<Flag[]>;
  autoResolveByMemoryId(memoryId: string): Promise<number>;
  hasOpenFlag(
    memoryId: string,
    flagType: FlagType,
    relatedMemoryId?: string,
  ): Promise<boolean>;
}

export interface RelationshipRepository {
  create(relationship: Relationship): Promise<Relationship>;
  findById(id: string): Promise<Relationship | null>;
  findByMemoryId(
    projectId: string,
    memoryId: string,
    direction: "outgoing" | "incoming" | "both",
    type?: string,
  ): Promise<Relationship[]>;
  findByMemoryIds(
    projectId: string,
    memoryIds: string[],
    direction: "outgoing" | "incoming" | "both",
    type?: string,
  ): Promise<Relationship[]>;
  findExisting(
    projectId: string,
    sourceId: string,
    targetId: string,
    type: string,
  ): Promise<Relationship | null>;
  findBetweenMemories(
    projectId: string,
    memoryIds: string[],
  ): Promise<Relationship[]>;
  archiveByMemoryId(memoryId: string, projectId: string): Promise<number>;
  archiveById(id: string): Promise<boolean>;
}

export interface RecentActivityOptions {
  project_id: string; // deployment project
  workspace_id: string;
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
