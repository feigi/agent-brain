import type {
  Memory,
  MemoryCreate,
  MemoryUpdate,
  MemoryWithRelevance,
  Comment,
  MemoryGetResponse,
  MemoryGetManyItem,
  FlagSummary,
  CreateSkipResult,
  MemorySummary,
  MemorySummaryWithRelevance,
  MemorySummaryWithChangeType,
  ChangeType,
} from "../types/memory.js";
import { toSummary, toDetail } from "../types/memory.js";
import type { Envelope } from "../types/envelope.js";
import type { EmbeddingProvider } from "../providers/embedding/types.js";
import type {
  MemoryRepository,
  WorkspaceRepository,
  ListOptions,
  CommentRepository,
  SessionTrackingRepository,
  SessionRepository,
} from "../repositories/types.js";
import type { AuditService } from "./audit-service.js";
import type { FlagService } from "./flag-service.js";
import type { RelationshipService } from "./relationship-service.js";
import type { FlagResponse } from "../types/flag.js";
import type { RelationshipWithMemory } from "../types/relationship.js";
import {
  NotFoundError,
  EmbeddingError,
  AuthorizationError,
  ValidationError,
} from "../utils/errors.js";
import { canAccessMemory } from "../utils/access.js";
import { generateId } from "../utils/id.js";
import { logger } from "../utils/logger.js";
import { computeRelevance, OVER_FETCH_FACTOR } from "../utils/scoring.js";
import { config } from "../config.js";

const MAX_CONTENT_WARNING = 4_000; // D-20: Warn but allow
const AUTO_TITLE_LENGTH = 80; // D-03: Auto-generate title length

export class MemoryService {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly projectId: string,
    private readonly commentRepo?: CommentRepository,
    private readonly sessionRepo?: SessionTrackingRepository,
    private readonly sessionLifecycleRepo?: SessionRepository,
    private readonly auditService?: AuditService,
    private readonly flagService?: FlagService,
    private readonly maxFlagsPerSession: number = 5,
    private readonly relationshipService?: RelationshipService,
  ) {}

  // D-12: Descriptive error for mutations
  private assertCanModify(memory: Memory, userId: string): void {
    if (!canAccessMemory(memory, userId)) {
      throw new AuthorizationError(
        "Cannot modify user-scoped memory owned by another user.",
      );
    }
  }

  // D-03: Auto-generate title if not provided
  // D-19: Concatenate title + content for embedding input
  // D-34: Auto-create project on first mention
  // D-54: Fail entirely if embedding fails (no partial state)
  // Phase 4: Three-stage pre-save guard chain (session validation, budget, dedup)
  async create(
    input: MemoryCreate,
  ): Promise<Envelope<Memory | CreateSkipResult>> {
    const start = Date.now();

    // Guard 0a -- Require workspace_id for workspace/user scope
    const effectiveScope = input.scope ?? "workspace";
    if (effectiveScope !== "project" && !input.workspace_id) {
      throw new ValidationError(
        `workspace_id is required for ${effectiveScope}-scoped memories.`,
      );
    }

    // Guard 0b -- Project-scope restriction: cannot be created by autonomous sources
    const isAutonomous =
      input.source === "agent-auto" || input.source === "session-review";

    if (effectiveScope === "project" && isAutonomous) {
      throw new ValidationError(
        `Project-scoped memories require user confirmation and cannot be created autonomously (source: '${input.source}').`,
      );
    }

    // Phase 4: Autonomous source flag (used for budget check + increment below)
    // session_id is optional — budget tracking is best-effort, not a hard gate

    // Phase 4: Guard 2 -- Budget check (D-10, D-12, D-13)
    // Manual writes (source: 'manual') bypass budget checks entirely
    if (isAutonomous && input.session_id && this.sessionLifecycleRepo) {
      const budget = await this.sessionLifecycleRepo.getBudget(
        input.session_id,
      );
      if (budget && budget.used >= budget.limit) {
        logger.debug(
          `Budget skip: session=${input.session_id} source=${input.source} used=${budget.used} limit=${budget.limit}`,
        );
        return {
          data: {
            skipped: true,
            reason: "budget_exceeded" as const,
            message: `Write budget exceeded (${budget.used}/${budget.limit}). Use source 'manual' to force-save.`,
          },
          meta: {
            budget: { used: budget.used, limit: budget.limit, exceeded: true },
            timing: Date.now() - start,
          },
        };
      }
    }

    // D-20: Warn on large content but allow
    if (input.content.length > MAX_CONTENT_WARNING) {
      logger.warn(
        `Memory content exceeds ${MAX_CONTENT_WARNING} chars (${input.content.length})`,
      );
    }

    // D-03: Auto-generate title from content if not provided
    const title =
      input.title ??
      (input.content.length > AUTO_TITLE_LENGTH
        ? input.content.slice(0, AUTO_TITLE_LENGTH) + "..."
        : input.content);

    // D-34: Ensure workspace exists (auto-create on first mention)
    // Skip for project-scoped memories without workspace_id
    if (input.workspace_id) {
      await this.workspaceRepo.findOrCreate(input.workspace_id);
    }

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

    // Phase 4: Guard 3 -- Semantic duplicate detection (D-14, D-15, D-16, D-17)
    const duplicates = await this.memoryRepo.findDuplicates({
      embedding,
      projectId: this.projectId,
      workspaceId: input.workspace_id ?? null,
      scope: effectiveScope,
      userId: input.author,
      threshold: config.duplicateThreshold,
    });

    if (duplicates.length > 0) {
      const dupInfo = duplicates[0];
      const message =
        dupInfo.scope !== effectiveScope
          ? `This already exists as shared knowledge (memory ${dupInfo.id}).`
          : `A similar memory already exists (memory ${dupInfo.id}, ${Math.round(dupInfo.relevance * 100)}% similar). Consider updating it instead.`;
      return {
        data: {
          skipped: true,
          reason: "duplicate" as const,
          message,
          duplicate: {
            id: dupInfo.id,
            title: dupInfo.title,
            relevance: dupInfo.relevance,
            scope: dupInfo.scope,
          },
        },
        meta: { timing: Date.now() - start },
      };
    }

    const id = generateId();
    const now = new Date();

    const memoryData: Memory & { embedding: number[] } = {
      id,
      project_id: this.projectId,
      workspace_id: input.workspace_id ?? null,
      content: input.content,
      title,
      type: input.type,
      scope: effectiveScope,
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
      comment_count: 0,
      flag_count: 0,
      relationship_count: 0,
      last_comment_at: null,
      verified_by: null,
    };

    const memory = await this.memoryRepo.create(memoryData);
    await this.auditService?.logCreate(memory.id, input.author);
    const timing = Date.now() - start;

    // Phase 4: Post-insert budget increment (D-10)
    // Increment budget after successful save for autonomous writes (best-effort)
    let budgetResult: { used: number; exceeded: boolean } | undefined;
    if (isAutonomous && input.session_id && this.sessionLifecycleRepo) {
      try {
        budgetResult = await this.sessionLifecycleRepo.incrementBudgetUsed(
          input.session_id,
          config.writeBudgetPerSession,
        );
      } catch (err) {
        logger.warn(
          `[budget] Failed to increment budget for session ${input.session_id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return {
      data: memory,
      meta: {
        timing,
        ...(budgetResult
          ? {
              budget: {
                used: budgetResult.used,
                limit: config.writeBudgetPerSession,
                exceeded: budgetResult.exceeded,
              },
            }
          : {}),
      },
    };
  }

  async get(id: string, userId: string): Promise<Envelope<Memory>> {
    const start = Date.now();

    const memory = await this.memoryRepo.findById(id);
    if (!memory) {
      throw new NotFoundError("Memory", id);
    }
    // Cross-project isolation: memory must belong to this deployment
    if (memory.project_id !== this.projectId) {
      throw new NotFoundError("Memory", id);
    }
    // D-17: user-scoped memories return "not found" for non-owners (don't leak existence)
    if (!canAccessMemory(memory, userId)) {
      throw new NotFoundError("Memory", id);
    }

    const timing = Date.now() - start;
    return { data: memory, meta: { timing } };
  }

  // D-63: Enhanced get with full comments array and capability booleans
  async getWithComments(
    id: string,
    userId: string,
  ): Promise<Envelope<MemoryGetResponse>> {
    const start = Date.now();

    const memory = await this.memoryRepo.findById(id);
    if (!memory) throw new NotFoundError("Memory", id);

    // Cross-project isolation
    if (memory.project_id !== this.projectId) {
      throw new NotFoundError("Memory", id);
    }

    // D-17: user-scoped memories return not-found for non-owners
    if (!canAccessMemory(memory, userId)) {
      throw new NotFoundError("Memory", id);
    }

    // D-63: Full comments array on memory_get only (oldest-first from repository)
    const commentsList: Comment[] = this.commentRepo
      ? await this.commentRepo.findByMemoryId(id)
      : [];

    // Open flags for this memory
    const flagsList: FlagSummary[] = [];
    if (this.flagService) {
      const allFlags = await this.flagService.getFlagsByMemoryId(id);
      for (const f of allFlags) {
        if (f.resolved_at) continue;
        let relatedMem = null;
        if (f.details.related_memory_id) {
          const related = await this.memoryRepo.findById(
            f.details.related_memory_id,
          );
          if (related) {
            relatedMem = {
              id: related.id,
              title: related.title,
              content: related.content,
              scope: related.scope,
            };
          }
        }
        flagsList.push({
          flag_id: f.id,
          flag_type: f.flag_type,
          related_memory: relatedMem,
          reason: f.details.reason,
        });
      }
    }

    let relationshipsList: RelationshipWithMemory[] = [];
    if (this.relationshipService) {
      try {
        relationshipsList = await this.relationshipService.listForMemory(
          id,
          "both",
          userId,
        );
      } catch (error) {
        logger.warn(`Failed to load relationships for memory ${id}:`, error);
      }
    }

    // D-72: Capability booleans
    const isOwner = memory.author === userId;
    const isShared = memory.scope === "workspace" || memory.scope === "project";
    const capabilities = {
      can_edit: canAccessMemory(memory, userId),
      can_archive: canAccessMemory(memory, userId),
      can_verify: canAccessMemory(memory, userId),
      // D-56: no self-comment; user-scoped memories can't have comments (owner blocks self-comment)
      can_comment: isShared && !isOwner,
    };

    const timing = Date.now() - start;
    return {
      data: {
        ...toDetail(memory),
        comments: commentsList,
        flags: flagsList,
        relationships: relationshipsList,
        ...capabilities,
      },
      meta: { timing },
    };
  }

  // Batch get: retrieve multiple memories by ID with optional include expansions
  async getMany(
    ids: string[],
    userId: string,
    include?: Array<"comments" | "flags" | "relationships">,
  ): Promise<Envelope<MemoryGetManyItem[]>> {
    const start = Date.now();

    const allMemories = await this.memoryRepo.findByIds(ids);
    const accessible = allMemories.filter(
      (m) => m.project_id === this.projectId && canAccessMemory(m, userId),
    );

    const returnedIds = new Set(accessible.map((m) => m.id));
    const omitted = ids.filter((id) => !returnedIds.has(id));

    // Early return if no accessible memories
    if (accessible.length === 0) {
      const timing = Date.now() - start;
      return {
        data: [],
        meta: {
          count: 0,
          timing,
          omitted: omitted.length > 0 ? omitted : undefined,
        },
      };
    }

    const accessibleIds = accessible.map((m) => m.id);
    const includeSet = new Set(include ?? []);

    // Batch-fetch optional joins
    let commentsByMemory = new Map<string, Comment[]>();
    let flagsByMemory = new Map<string, FlagSummary[]>();
    let relsByMemory = new Map<string, RelationshipWithMemory[]>();

    if (includeSet.has("comments") && this.commentRepo) {
      const allComments = await this.commentRepo.findByMemoryIds(accessibleIds);
      commentsByMemory = groupBy(allComments, "memory_id");
    }

    if (includeSet.has("flags") && this.flagService) {
      flagsByMemory = await this.batchFetchFlags(accessibleIds);
    }

    if (includeSet.has("relationships") && this.relationshipService) {
      relsByMemory = await this.batchFetchRelationships(accessibleIds, userId);
    }

    const items: MemoryGetManyItem[] = accessible.map((memory) => {
      const isOwner = memory.author === userId;
      const isShared =
        memory.scope === "workspace" || memory.scope === "project";

      const item: MemoryGetManyItem = {
        ...toDetail(memory),
        flag_count: memory.flag_count,
        relationship_count: memory.relationship_count,
        can_edit: canAccessMemory(memory, userId),
        can_archive: canAccessMemory(memory, userId),
        can_verify: canAccessMemory(memory, userId),
        can_comment: isShared && !isOwner,
      };

      if (includeSet.has("comments")) {
        item.comments = commentsByMemory.get(memory.id) ?? [];
      }
      if (includeSet.has("flags")) {
        item.flags = flagsByMemory.get(memory.id) ?? [];
      }
      if (includeSet.has("relationships")) {
        item.relationships = relsByMemory.get(memory.id) ?? [];
      }

      return item;
    });

    const timing = Date.now() - start;
    return {
      data: items,
      meta: {
        count: items.length,
        timing,
        omitted: omitted.length > 0 ? omitted : undefined,
      },
    };
  }

  private async batchFetchFlags(
    memoryIds: string[],
  ): Promise<Map<string, FlagSummary[]>> {
    if (!this.flagService) return new Map();

    const allFlags = await this.flagService.findByMemoryIds(memoryIds);

    // Batch-fetch all related memories in one query instead of N+1
    const relatedMemoryIds = allFlags
      .map((f) => f.details.related_memory_id)
      .filter((id): id is string => !!id);
    const relatedMemories =
      relatedMemoryIds.length > 0
        ? await this.memoryRepo.findByIds([...new Set(relatedMemoryIds)])
        : [];
    const relatedMap = new Map(relatedMemories.map((m) => [m.id, m]));

    const map = new Map<string, FlagSummary[]>();
    for (const f of allFlags) {
      if (f.resolved_at) continue;
      let relatedMem = null;
      if (f.details.related_memory_id) {
        const related = relatedMap.get(f.details.related_memory_id);
        if (related) {
          relatedMem = {
            id: related.id,
            title: related.title,
            content: related.content,
            scope: related.scope,
          };
        }
      }
      const entry = {
        flag_id: f.id,
        flag_type: f.flag_type,
        related_memory: relatedMem,
        reason: f.details.reason,
      };
      const arr = map.get(f.memory_id);
      if (arr) {
        arr.push(entry);
      } else {
        map.set(f.memory_id, [entry]);
      }
    }
    return map;
  }

  private async batchFetchRelationships(
    memoryIds: string[],
    userId: string,
  ): Promise<Map<string, RelationshipWithMemory[]>> {
    if (!this.relationshipService) return new Map();

    const { relationships: rels } =
      await this.relationshipService.listForMemories(memoryIds, "both", userId);
    const map = new Map<string, RelationshipWithMemory[]>();
    for (const rel of rels) {
      const anchorId =
        rel.direction === "outgoing" ? rel.source_id : rel.target_id;
      const arr = map.get(anchorId);
      if (arr) {
        arr.push(rel);
      } else {
        map.set(anchorId, [rel]);
      }
    }
    return map;
  }

  // D-44 through D-50: Add comment to a project memory authored by another user
  async addComment(
    memoryId: string,
    userId: string,
    content: string,
  ): Promise<Envelope<Comment>> {
    const start = Date.now();
    if (!this.commentRepo) throw new Error("CommentRepository not initialized");

    // Fetch parent memory
    const memory = await this.memoryRepo.findById(memoryId);
    if (!memory) throw new NotFoundError("Memory", memoryId);

    // Cross-project isolation
    if (memory.project_id !== this.projectId) {
      throw new NotFoundError("Memory", memoryId);
    }

    // D-55: No comments on archived memories
    if (memory.archived_at) {
      throw new ValidationError("Cannot comment on an archived memory.");
    }

    // D-48: Comments inherit parent scope access rules
    // User-scoped memories: only owner can access. But D-56 blocks self-comment.
    // So user-scoped memories effectively cannot have comments.
    if (memory.scope === "user") {
      if (memory.author !== userId) {
        throw new NotFoundError("Memory", memoryId); // D-17: hide existence
      }
      // Owner trying to comment on their own user-scoped memory = self-comment block
      throw new ValidationError(
        "Cannot comment on your own memory. Use memory_update to add context.",
      );
    }

    // D-56: No self-commenting on project memories
    if (memory.author === userId) {
      throw new ValidationError(
        "Cannot comment on your own memory. Use memory_update to add context.",
      );
    }

    // D-49: Soft limit ~1000 chars -- warn but allow
    if (content.length > 1000) {
      logger.warn(`Comment content exceeds 1000 chars (${content.length})`);
    }

    // D-50: Soft limit ~50 comments per memory -- warn but allow
    const currentCount = await this.commentRepo.countByMemoryId(memoryId);
    if (currentCount >= 50) {
      logger.warn(
        `Memory ${memoryId} has ${currentCount} comments (soft limit 50)`,
      );
    }

    const commentId = generateId();
    const comment = await this.commentRepo.create({
      id: commentId,
      memory_id: memoryId,
      author: userId,
      content,
    });

    await this.auditService?.logComment(memoryId, userId);

    const timing = Date.now() - start;
    return {
      data: comment,
      meta: { comment_count: currentCount + 1, timing },
    };
  }

  // D-33 through D-40: List memories with change_type for team activity awareness
  async listRecentActivity(
    workspaceId: string,
    userId: string,
    since: Date,
    limit: number = 10,
    excludeSelf: boolean = false,
  ): Promise<Envelope<MemorySummaryWithChangeType[]>> {
    const start = Date.now();

    const recentMemories = await this.memoryRepo.findRecentActivity({
      project_id: this.projectId,
      workspace_id: workspaceId,
      user_id: userId,
      since,
      limit,
      exclude_self: excludeSelf,
    });

    // D-37: Determine change_type for each result
    const withChangeType: MemorySummaryWithChangeType[] = recentMemories.map(
      (memory) => ({
        ...toSummary(memory),
        change_type: this.getChangeType(memory, since),
      }),
    );

    const timing = Date.now() - start;
    return {
      data: withChangeType,
      meta: { count: withChangeType.length, timing },
    };
  }

  // D-37, D-62: Determine change_type based on timestamps
  private getChangeType(memory: Memory, since: Date): ChangeType {
    if (memory.created_at >= since) return "created";
    if (
      memory.last_comment_at &&
      memory.updated_at.getTime() === memory.last_comment_at.getTime()
    ) {
      return "commented";
    }
    return "updated";
  }

  // D-27: Re-embed when content or title changes
  async update(
    id: string,
    expectedVersion: number,
    updates: MemoryUpdate,
    userId: string,
  ): Promise<Envelope<Memory>> {
    const start = Date.now();

    // Fetch first for access control check (also needed for re-embedding)
    const existing = await this.memoryRepo.findById(id);
    if (!existing) {
      throw new NotFoundError("Memory", id);
    }
    // Cross-project isolation
    if (existing.project_id !== this.projectId) {
      throw new NotFoundError("Memory", id);
    }
    this.assertCanModify(existing, userId);

    const needsReEmbed =
      updates.content !== undefined || updates.title !== undefined;

    let embeddingUpdates: {
      embedding?: number[];
      embedding_model?: string;
      embedding_dimensions?: number;
    } = {};

    if (needsReEmbed) {
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

    const before = {
      content: existing.content,
      title: existing.title,
      type: existing.type,
      tags: existing.tags,
      metadata: existing.metadata,
    };

    const memory = await this.memoryRepo.update(id, expectedVersion, {
      ...updates,
      ...embeddingUpdates,
    });

    const after = {
      content: memory.content,
      title: memory.title,
      type: memory.type,
      tags: memory.tags,
      metadata: memory.metadata,
    };
    await this.auditService?.logUpdate(id, userId, { before, after });

    const timing = Date.now() - start;
    return { data: memory, meta: { timing } };
  }

  // D-06: Accepts single ID or array
  // D-15: Check access on each memory before archiving
  async archive(
    ids: string | string[],
    userId: string,
  ): Promise<Envelope<{ archived_count: number }>> {
    const start = Date.now();

    const idArray = Array.isArray(ids) ? ids : [ids];

    // Check access on each memory before archiving
    const verifiedIds: string[] = [];
    for (const id of idArray) {
      const memory = await this.memoryRepo.findById(id);
      if (memory) {
        // Cross-project isolation
        if (memory.project_id !== this.projectId) {
          throw new NotFoundError("Memory", id);
        }
        // D-67: If memory not found, archive is idempotent -- skip check
        this.assertCanModify(memory, userId);
        verifiedIds.push(id);
      }
    }

    const archivedCount = await this.memoryRepo.archive(verifiedIds);

    if (this.relationshipService) {
      for (const id of verifiedIds) {
        try {
          await this.relationshipService.archiveByMemoryId(id);
        } catch (error) {
          logger.error(
            `Failed to archive relationships for memory ${id}:`,
            error,
          );
        }
      }
    }

    for (const id of verifiedIds) {
      await this.auditService?.logArchive(id, userId);
    }

    const timing = Date.now() - start;
    return { data: { archived_count: archivedCount }, meta: { timing } };
  }

  async search(
    query: string,
    workspace_id: string,
    scope: Array<"workspace" | "user" | "project">,
    user_id: string,
    limit?: number,
    min_similarity?: number,
  ): Promise<Envelope<MemorySummaryWithRelevance[]>> {
    const start = Date.now();
    const effectiveLimit = limit ?? 10;

    // Generate embedding for query text
    let embedding: number[];
    try {
      embedding = await this.embeddingProvider.embed(query);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingError(
        `Failed to generate query embedding: ${message}`,
      );
    }

    // Over-fetch candidates by raw similarity for re-ranking (D-04)
    const overFetchLimit = effectiveLimit * OVER_FETCH_FACTOR;
    const candidates = await this.memoryRepo.search({
      embedding,
      project_id: this.projectId,
      workspace_id,
      scope,
      user_id,
      limit: overFetchLimit,
      min_similarity,
    });

    // Re-rank with composite scoring (D-04: app-layer scoring)
    const scored: MemoryWithRelevance[] = candidates.map((candidate) => {
      const { relevance: _rawSimilarity, ...memory } = candidate;
      return {
        ...memory,
        relevance: computeRelevance(
          _rawSimilarity,
          candidate.created_at,
          candidate.verified_at,
          config.recencyHalfLifeDays,
        ),
      };
    });

    // Sort by composite relevance descending, take top N
    scored.sort((a, b) => b.relevance - a.relevance);
    const results = scored.slice(0, effectiveLimit);

    const projected: MemorySummaryWithRelevance[] = results.map((r) => ({
      ...toSummary(r),
      relevance: r.relevance,
    }));

    const timing = Date.now() - start;
    return {
      data: projected,
      meta: { count: projected.length, timing },
    };
  }

  async sessionStart(
    workspaceId: string,
    userId: string,
    context?: string,
    limit: number = 10,
  ): Promise<Envelope<MemorySummaryWithRelevance[]>> {
    const start = Date.now();

    // D-34: Auto-create workspace
    await this.workspaceRepo.findOrCreate(workspaceId);

    // Phase 4: Generate session_id and create session record for budget tracking (D-18)
    const sessionId = generateId();
    await this.sessionLifecycleRepo?.createSession(
      sessionId,
      userId,
      this.projectId,
      workspaceId,
    );

    // D-28: Track session, get previous session timestamp
    let previousSession: Date | null = null;
    if (this.sessionRepo) {
      previousSession = await this.sessionRepo.upsert(
        userId,
        this.projectId,
        workspaceId,
      );
    }

    // D-31: First session falls back to 7 days
    const FIRST_SESSION_FALLBACK_DAYS = 7;
    const since =
      previousSession ??
      new Date(Date.now() - FIRST_SESSION_FALLBACK_DAYS * 24 * 60 * 60 * 1000);

    let result: Envelope<MemorySummaryWithRelevance[]>;
    if (context) {
      // D-14: With context, use semantic search with composite scoring
      // D-15: Always search both scopes
      // min_similarity = -1 -- session start should be maximally permissive
      result = await this.search(
        context,
        workspaceId,
        ["workspace", "user"],
        userId,
        limit,
        -1,
      );
    } else {
      // D-14: Without context, fetch recent memories ranked by recency
      const recentMemories = await this.memoryRepo.listRecentBothScopes({
        project_id: this.projectId,
        workspace_id: workspaceId,
        user_id: userId,
        limit,
      });

      // Apply composite scoring with similarity = 1.0 (neutral baseline)
      const scored: MemorySummaryWithRelevance[] = recentMemories.map(
        (memory) => ({
          ...toSummary(memory),
          relevance: computeRelevance(
            1.0, // neutral similarity -- recency dominates
            memory.created_at,
            memory.verified_at,
            config.recencyHalfLifeDays,
          ),
        }),
      );
      scored.sort((a, b) => b.relevance - a.relevance);
      const timing = Date.now() - start;
      result = { data: scored, meta: { count: scored.length, timing } };
    }

    // D-29: Add team_activity counts to meta
    let teamActivity:
      | {
          new_memories: number;
          updated_memories: number;
          commented_memories: number;
          since: string;
        }
      | undefined;
    if (this.memoryRepo.countTeamActivity) {
      const counts = await this.memoryRepo.countTeamActivity(
        this.projectId,
        workspaceId,
        userId,
        since,
      );
      teamActivity = {
        ...counts,
        since: since.toISOString(),
      };
    }

    // Fetch open flags for this workspace (bypass ranking)
    let flagsData: FlagResponse[] | undefined;

    if (this.flagService) {
      const openFlags = await this.flagService.getOpenFlags(
        workspaceId,
        this.maxFlagsPerSession,
      );
      if (openFlags.length > 0) {
        const enriched: FlagResponse[] = [];
        for (const f of openFlags) {
          const mem = await this.memoryRepo.findById(f.memory_id);
          if (!mem) continue; // Memory was archived/deleted since flag was created
          let relatedMem = null;
          if (f.details.related_memory_id) {
            const related = await this.memoryRepo.findById(
              f.details.related_memory_id,
            );
            if (related) {
              relatedMem = {
                id: related.id,
                title: related.title,
                content: related.content,
                scope: related.scope,
              };
            }
          }
          enriched.push({
            flag_id: f.id,
            flag_type: f.flag_type,
            memory: {
              id: mem.id,
              title: mem.title,
              content: mem.content,
              scope: mem.scope,
            },
            related_memory: relatedMem,
            reason: f.details.reason,
          });
        }
        if (enriched.length > 0) flagsData = enriched;
      }
    }

    let relationshipsData: Envelope<
      MemorySummaryWithRelevance[]
    >["meta"]["relationships"];
    if (this.relationshipService && result.data.length >= 2) {
      try {
        const memoryIds = result.data.map((m) => m.id);
        const rels = await this.relationshipService.listBetweenMemories(
          memoryIds,
          userId,
        );
        if (rels.length > 0) {
          relationshipsData = rels.map((r) => ({
            id: r.id,
            type: r.type,
            description: r.description,
            confidence: r.confidence,
            source_id: r.source_id,
            target_id: r.target_id,
          }));
        }
      } catch (error) {
        logger.warn("Failed to load relationships for session_start:", error);
      }
    }

    const timing = Date.now() - start;
    return {
      data: result.data,
      meta: {
        ...result.meta,
        timing,
        team_activity: teamActivity,
        session_id: sessionId,
        flags: flagsData,
        relationships: relationshipsData,
      },
    };
  }

  async list(options: ListOptions): Promise<Envelope<MemorySummary[]>> {
    const start = Date.now();

    const result = await this.memoryRepo.list(options);

    const projected = result.memories.map(toSummary);

    const timing = Date.now() - start;
    return {
      data: projected,
      meta: {
        count: projected.length,
        has_more: result.has_more,
        cursor: result.cursor
          ? `${result.cursor.created_at}|${result.cursor.id}`
          : undefined,
        timing,
      },
    };
  }

  async verify(id: string, userId: string): Promise<Envelope<Memory>> {
    const start = Date.now();

    const existing = await this.memoryRepo.findById(id);
    if (!existing) {
      throw new NotFoundError("Memory", id);
    }
    // Cross-project isolation
    if (existing.project_id !== this.projectId) {
      throw new NotFoundError("Memory", id);
    }
    // D-20: project=anyone can verify, user=owner only
    if (!canAccessMemory(existing, userId)) {
      throw new AuthorizationError(
        "Cannot verify user-scoped memory owned by another user.",
      );
    }

    const memory = await this.memoryRepo.verify(id, userId);
    if (!memory) {
      throw new NotFoundError("Memory", id);
    }

    const timing = Date.now() - start;
    return { data: memory, meta: { timing } };
  }

  async listStale(
    workspace_id: string,
    userId: string,
    threshold_days: number,
    limit?: number,
    cursor?: { created_at: string; id: string },
  ): Promise<Envelope<MemorySummary[]>> {
    const start = Date.now();

    const result = await this.memoryRepo.findStale({
      project_id: this.projectId,
      workspace_id,
      threshold_days,
      limit,
      cursor,
    });

    // D-16: Filter out user-scoped memories not owned by requesting user
    const filtered = result.memories.filter((m) => canAccessMemory(m, userId));

    const projected = filtered.map(toSummary);

    const timing = Date.now() - start;
    return {
      data: projected,
      meta: {
        count: projected.length,
        has_more: result.has_more,
        cursor: result.cursor
          ? `${result.cursor.created_at}|${result.cursor.id}`
          : undefined,
        timing,
      },
    };
  }
}

function groupBy<T>(items: T[], key: keyof T & string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = item[key] as string;
    const arr = map.get(k);
    if (arr) {
      arr.push(item);
    } else {
      map.set(k, [item]);
    }
  }
  return map;
}
