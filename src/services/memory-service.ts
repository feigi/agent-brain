import type { Memory, MemoryCreate, MemoryUpdate, MemoryWithRelevance } from "../types/memory.js";
import type { Envelope } from "../types/envelope.js";
import type { EmbeddingProvider } from "../providers/embedding/types.js";
import type { MemoryRepository, ProjectRepository, ListOptions, SearchOptions, StaleOptions } from "../repositories/types.js";
import { NotFoundError, EmbeddingError } from "../utils/errors.js";
import { generateId } from "../utils/id.js";
import { logger } from "../utils/logger.js";

const MAX_CONTENT_WARNING = 4_000; // D-20: Warn but allow
const AUTO_TITLE_LENGTH = 80;      // D-03: Auto-generate title length

export class MemoryService {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly projectRepo: ProjectRepository,
    private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  // D-03: Auto-generate title if not provided
  // D-19: Concatenate title + content for embedding input
  // D-34: Auto-create project on first mention
  // D-54: Fail entirely if embedding fails (no partial state)
  async create(input: MemoryCreate): Promise<Envelope<Memory>> {
    const start = Date.now();

    // D-20: Warn on large content but allow
    if (input.content.length > MAX_CONTENT_WARNING) {
      logger.warn(`Memory content exceeds ${MAX_CONTENT_WARNING} chars (${input.content.length})`);
    }

    // D-03: Auto-generate title from content if not provided
    const title = input.title ?? (
      input.content.length > AUTO_TITLE_LENGTH
        ? input.content.slice(0, AUTO_TITLE_LENGTH) + "..."
        : input.content
    );

    // D-34: Ensure project exists (auto-create on first mention)
    await this.projectRepo.findOrCreate(input.project_id);

    // D-19: Embed title + content concatenated
    const embeddingInput = `${title}\n\n${input.content}`;
    let embedding: number[];
    try {
      embedding = await this.embeddingProvider.embed(embeddingInput);
    } catch (error) {
      // D-54: Fail the save entirely if embedding fails
      if (error instanceof EmbeddingError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingError(`Failed to generate embedding: ${message}`);
    }

    const id = generateId();
    const now = new Date();

    const memoryData: Memory & { embedding: number[] } = {
      id,
      project_id: input.project_id,
      content: input.content,
      title,
      type: input.type,
      scope: input.scope ?? "project",
      tags: input.tags ?? null,
      author: input.author,
      source: input.source ?? null,
      session_id: input.session_id ?? null,
      metadata: input.metadata ?? null,
      embedding,
      embedding_model: this.embeddingProvider.modelName,
      embedding_dimensions: this.embeddingProvider.dimensions,
      version: 1,
      created_at: now,
      updated_at: now,
      verified_at: null,
      archived_at: null,
    };

    const memory = await this.memoryRepo.create(memoryData);
    const timing = Date.now() - start;

    return { data: memory, meta: { timing } };
  }

  async get(id: string): Promise<Envelope<Memory>> {
    const start = Date.now();

    const memory = await this.memoryRepo.findById(id);
    if (!memory) {
      throw new NotFoundError("Memory", id);
    }

    const timing = Date.now() - start;
    return { data: memory, meta: { timing } };
  }

  // D-27: Re-embed when content or title changes
  async update(id: string, expectedVersion: number, updates: MemoryUpdate): Promise<Envelope<Memory>> {
    const start = Date.now();

    const needsReEmbed = updates.content !== undefined || updates.title !== undefined;

    let embeddingUpdates: { embedding?: number[]; embedding_model?: string; embedding_dimensions?: number } = {};

    if (needsReEmbed) {
      // Get existing memory to build full embedding input
      const existing = await this.memoryRepo.findById(id);
      if (!existing) {
        throw new NotFoundError("Memory", id);
      }

      const newTitle = updates.title ?? existing.title;
      const newContent = updates.content ?? existing.content;
      const embeddingInput = `${newTitle}\n\n${newContent}`;

      let embedding: number[];
      try {
        embedding = await this.embeddingProvider.embed(embeddingInput);
      } catch (error) {
        if (error instanceof EmbeddingError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new EmbeddingError(`Failed to generate embedding: ${message}`);
      }

      embeddingUpdates = {
        embedding,
        embedding_model: this.embeddingProvider.modelName,
        embedding_dimensions: this.embeddingProvider.dimensions,
      };
    }

    const memory = await this.memoryRepo.update(id, expectedVersion, {
      ...updates,
      ...embeddingUpdates,
    });

    const timing = Date.now() - start;
    return { data: memory, meta: { timing } };
  }

  // D-06: Accepts single ID or array
  async archive(ids: string | string[]): Promise<Envelope<{ archived_count: number }>> {
    const start = Date.now();

    const idArray = Array.isArray(ids) ? ids : [ids];
    const archivedCount = await this.memoryRepo.archive(idArray);

    const timing = Date.now() - start;
    return { data: { archived_count: archivedCount }, meta: { timing } };
  }

  async search(
    query: string,
    project_id: string,
    scope: "project" | "user",
    user_id?: string,
    limit?: number,
    min_similarity?: number,
  ): Promise<Envelope<MemoryWithRelevance[]>> {
    const start = Date.now();

    // Generate embedding for query text
    let embedding: number[];
    try {
      embedding = await this.embeddingProvider.embed(query);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingError(`Failed to generate query embedding: ${message}`);
    }

    const results = await this.memoryRepo.search({
      embedding,
      project_id,
      scope,
      user_id,
      limit,
      min_similarity,
    });

    const timing = Date.now() - start;
    return {
      data: results,
      meta: { count: results.length, timing },
    };
  }

  async list(options: ListOptions): Promise<Envelope<Memory[]>> {
    const start = Date.now();

    const result = await this.memoryRepo.list(options);

    const timing = Date.now() - start;
    return {
      data: result.memories,
      meta: {
        count: result.memories.length,
        has_more: result.has_more,
        cursor: result.cursor ? `${result.cursor.created_at}|${result.cursor.id}` : undefined,
        timing,
      },
    };
  }

  async verify(id: string): Promise<Envelope<Memory>> {
    const start = Date.now();

    const memory = await this.memoryRepo.verify(id);
    if (!memory) {
      throw new NotFoundError("Memory", id);
    }

    const timing = Date.now() - start;
    return { data: memory, meta: { timing } };
  }

  async listStale(
    project_id: string,
    threshold_days: number,
    limit?: number,
    cursor?: { created_at: string; id: string },
  ): Promise<Envelope<Memory[]>> {
    const start = Date.now();

    const result = await this.memoryRepo.findStale({
      project_id,
      threshold_days,
      limit,
      cursor,
    });

    const timing = Date.now() - start;
    return {
      data: result.memories,
      meta: {
        count: result.memories.length,
        has_more: result.has_more,
        cursor: result.cursor ? `${result.cursor.created_at}|${result.cursor.id}` : undefined,
        timing,
      },
    };
  }
}
