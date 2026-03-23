import type { Memory, MemoryCreate, MemoryUpdate, MemoryWithRelevance } from "../types/memory.js";

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
  scope: "project" | "user";
  user_id?: string;
  limit?: number;
  min_similarity?: number;
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
  update(id: string, expectedVersion: number, updates: Partial<Memory> & { embedding?: number[] | null }): Promise<Memory>;
  archive(ids: string[]): Promise<number>;
  search(options: SearchOptions): Promise<MemoryWithRelevance[]>;
  list(options: ListOptions): Promise<{ memories: Memory[]; has_more: boolean; cursor?: { created_at: string; id: string } }>;
  findStale(options: StaleOptions): Promise<{ memories: Memory[]; has_more: boolean; cursor?: { created_at: string; id: string } }>;
  verify(id: string): Promise<Memory | null>;
}

export interface ProjectRepository {
  findOrCreate(slug: string): Promise<{ id: string; created_at: Date }>;
  findById(slug: string): Promise<{ id: string; created_at: Date } | null>;
}
