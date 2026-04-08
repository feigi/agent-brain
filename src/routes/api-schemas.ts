import { z } from "zod";
import {
  slugSchema,
  contentSchema,
  memoryTypeEnum,
  memoryScopeEnum,
} from "../utils/validation.js";

export const toolSchemas = {
  memory_session_start: z.object({
    workspace_id: slugSchema,
    user_id: slugSchema,
    context: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),

  memory_create: z.object({
    workspace_id: slugSchema.optional(),
    content: contentSchema,
    title: z.string().optional(),
    type: memoryTypeEnum,
    tags: z.array(z.string()).optional(),
    scope: memoryScopeEnum.default("workspace"),
    user_id: slugSchema,
    source: z.string().optional(),
    session_id: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),

  memory_get: z.object({
    id: z.string().min(1),
    user_id: slugSchema,
  }),

  memory_update: z.object({
    id: z.string().min(1),
    version: z.number().int(),
    content: contentSchema.optional(),
    title: z.string().optional(),
    type: memoryTypeEnum.optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    user_id: slugSchema,
  }),

  memory_archive: z.object({
    ids: z.union([z.string().min(1), z.array(z.string().min(1))]),
    user_id: slugSchema,
  }),

  memory_search: z.object({
    query: z.string().min(1),
    workspace_id: slugSchema,
    scope: z.enum(["workspace", "user", "both"]).default("workspace"),
    user_id: slugSchema,
    limit: z.number().int().min(1).max(100).default(10),
    min_similarity: z.number().min(0).max(1).default(0.3),
  }),

  memory_list: z.object({
    workspace_id: slugSchema.optional(),
    scope: z.array(memoryScopeEnum).min(1).default(["workspace"]),
    user_id: slugSchema,
    type: memoryTypeEnum.optional(),
    tags: z.array(z.string()).optional(),
    sort_by: z.enum(["created_at", "updated_at"]).default("created_at"),
    order: z.enum(["asc", "desc"]).default("desc"),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),

  memory_verify: z.object({
    id: z.string().min(1),
    user_id: slugSchema,
  }),

  memory_list_stale: z.object({
    workspace_id: slugSchema,
    user_id: slugSchema,
    threshold_days: z.number().int().min(1).default(30),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  }),

  memory_comment: z.object({
    memory_id: z.string().min(1),
    user_id: slugSchema,
    content: contentSchema,
  }),

  memory_list_recent: z.object({
    workspace_id: slugSchema,
    user_id: slugSchema,
    since: z.string().datetime(),
    limit: z.number().int().min(1).max(100).default(10),
    exclude_self: z.boolean().default(false),
  }),

  memory_relate: z.object({
    source_id: z.string().min(1),
    target_id: z.string().min(1),
    type: z.string().min(1).max(64),
    description: z.string().max(500).optional(),
    confidence: z.number().min(0).max(1).optional(),
    user_id: slugSchema,
    created_via: z.string().optional(),
  }),

  memory_unrelate: z.object({
    id: z.string().min(1),
    user_id: slugSchema,
  }),

  memory_relationships: z.object({
    memory_id: z.string().min(1),
    direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
    type: z.string().optional(),
    user_id: slugSchema,
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;
