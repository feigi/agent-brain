import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  vector,
  unique,
  real,
  check,
} from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { config } from "../config.js";

// D-17: Predefined memory types as PostgreSQL enum
export const memoryTypeEnum = pgEnum("memory_type", [
  "fact",
  "decision",
  "learning",
  "pattern",
  "preference",
  "architecture",
]);

// D-08: Memory scope enum
// workspace = scoped to workspace, user = private, project = cross-workspace within deployment
export const memoryScopeEnum = pgEnum("memory_scope", [
  "workspace",
  "user",
  "project",
]);

// Workspaces identified by human-readable slug (auto-created on first use)
export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(), // slug string, e.g. "agent-brain"
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(), // nanoid (D-18)
    project_id: text("project_id").notNull(), // deployment project (from server config)
    workspace_id: text("workspace_id").references(() => workspaces.id), // nullable for project-scoped memories
    content: text("content").notNull(), // CORE-08: raw text
    title: text("title").notNull(), // D-03: auto-generated if omitted
    type: memoryTypeEnum("type").notNull(), // D-16, D-17: CORE-06
    scope: memoryScopeEnum("scope").notNull().default("workspace"), // D-08: SCOP-01, SCOP-02
    tags: text("tags")
      .array()
      .default(sql`'{}'::text[]`), // D-16: free-form tags
    author: text("author").notNull(), // D-25, D-38
    source: text("source"), // D-23: manual, agent-auto, etc.
    session_id: text("session_id"), // D-24
    metadata: jsonb("metadata").$type<Record<string, unknown>>(), // D-26: extensible JSONB
    embedding: vector("embedding", { dimensions: config.embeddingDimensions }), // INFR-04: configurable dimensions
    embedding_model: text("embedding_model"), // D-22, CORE-09
    embedding_dimensions: integer("embedding_dimensions"), // D-22, CORE-09
    version: integer("version").notNull().default(1), // D-30: optimistic locking
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(), // D-21
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(), // D-21
    verified_at: timestamp("verified_at", { withTimezone: true }), // D-21, D-11
    archived_at: timestamp("archived_at", { withTimezone: true }), // D-21, D-28
    verified_by: text("verified_by"), // D-19: who verified
    last_comment_at: timestamp("last_comment_at", { withTimezone: true }), // D-62: for change_type detection
  },
  (table) => [
    index("memories_embedding_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
    index("memories_project_id_idx").on(table.project_id),
    index("memories_workspace_id_idx").on(table.workspace_id),
    index("memories_author_idx").on(table.author),
    index("memories_type_idx").on(table.type),
    index("memories_created_at_idx").on(table.created_at),
  ],
);

// D-44, D-45, D-47, D-51: Comments on memories for team collaboration
export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey(), // nanoid (D-51)
    memory_id: text("memory_id")
      .notNull()
      .references(() => memories.id), // FK to memories (D-44)
    author: text("author").notNull(), // who commented (D-47)
    content: text("content").notNull(), // comment text (D-47)
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(), // D-47
  },
  (table) => [
    index("comments_memory_id_idx").on(table.memory_id),
    index("comments_created_at_idx").on(table.created_at),
  ],
);

// Phase 4: Session lifecycle table for budget tracking and agent autonomy (D-18)
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // nanoid session_id (D-18)
  user_id: text("user_id").notNull(),
  project_id: text("project_id").notNull(), // deployment project
  workspace_id: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  budget_used: integer("budget_used").notNull().default(0),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Track last session per user per workspace per project for team activity detection
export const sessionTracking = pgTable(
  "session_tracking",
  {
    user_id: text("user_id").notNull(),
    project_id: text("project_id").notNull(), // deployment project
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    last_session_at: timestamp("last_session_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("session_tracking_user_workspace_project_idx").on(
      table.user_id,
      table.workspace_id,
      table.project_id,
    ),
  ],
);

// Audit log: tracks all memory mutations for consolidation traceability
export const auditActionEnum = pgEnum("audit_action", [
  "created",
  "updated",
  "archived",
  "merged",
  "flagged",
  "commented",
]);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id").notNull(),
    memory_id: text("memory_id")
      .notNull()
      .references(() => memories.id),
    action: auditActionEnum("action").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason"),
    diff: jsonb("diff").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_log_memory_id_idx").on(table.memory_id),
    index("audit_log_project_id_idx").on(table.project_id),
  ],
);

// Flags: consolidation-detected issues requiring review or auto-resolved
export const flagTypeEnum = pgEnum("flag_type", [
  "duplicate",
  "contradiction",
  "override",
  "superseded",
  "verify",
]);

export const flagSeverityEnum = pgEnum("flag_severity", [
  "auto_resolved",
  "needs_review",
]);

export const flags = pgTable(
  "flags",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id").notNull(),
    memory_id: text("memory_id")
      .notNull()
      .references(() => memories.id),
    flag_type: flagTypeEnum("flag_type").notNull(),
    severity: flagSeverityEnum("severity").notNull(),
    details: jsonb("details").notNull().$type<{
      related_memory_id?: string;
      relationship_id?: string;
      similarity?: number;
      reason: string;
    }>(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    resolved_by: text("resolved_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("flags_memory_id_idx").on(table.memory_id),
    index("flags_severity_resolved_idx").on(table.severity, table.resolved_at),
  ],
);

// ── Relationships ────────────────────────────────────────────────
export const relationships = pgTable(
  "relationships",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id").notNull(),
    source_id: text("source_id")
      .notNull()
      .references(() => memories.id),
    target_id: text("target_id")
      .notNull()
      .references(() => memories.id),
    type: text("type").notNull(),
    description: text("description"),
    confidence: real("confidence").notNull().default(1.0),
    created_by: text("created_by").notNull(),
    source: text("source"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("relationships_unique_edge").on(
      table.project_id,
      table.source_id,
      table.target_id,
      table.type,
    ),
    index("relationships_source_idx").on(table.source_id),
    index("relationships_target_idx").on(table.target_id),
    index("relationships_project_type_idx").on(table.project_id, table.type),
    check("relationships_no_self_ref", sql`source_id != target_id`),
  ],
);
