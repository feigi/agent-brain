import { pgTable, text, timestamp, integer, jsonb, index, vector } from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// D-17: Predefined memory types as PostgreSQL enum
export const memoryTypeEnum = pgEnum("memory_type", [
  "fact", "decision", "learning", "pattern", "preference", "architecture",
]);

// D-08: Memory scope enum
export const memoryScopeEnum = pgEnum("memory_scope", ["project", "user"]);

// D-32: Projects identified by human-readable slug
export const projects = pgTable("projects", {
  id: text("id").primaryKey(), // slug string, e.g. "agentic-brain"
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),                                    // nanoid (D-18)
    project_id: text("project_id").notNull().references(() => projects.id),  // D-31
    content: text("content").notNull(),                              // CORE-08: raw text
    title: text("title").notNull(),                                  // D-03: auto-generated if omitted
    type: memoryTypeEnum("type").notNull(),                          // D-16, D-17: CORE-06
    scope: memoryScopeEnum("scope").notNull().default("project"),    // D-08: SCOP-01, SCOP-02
    tags: text("tags").array().default(sql`'{}'::text[]`),           // D-16: free-form tags
    author: text("author").notNull(),                                // D-25, D-38
    source: text("source"),                                          // D-23: manual, agent-auto, etc.
    session_id: text("session_id"),                                  // D-24
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),    // D-26: extensible JSONB
    embedding: vector("embedding", { dimensions: 512 }),              // INFR-04: 512d per strategy
    embedding_model: text("embedding_model"),                         // D-22, CORE-09
    embedding_dimensions: integer("embedding_dimensions"),            // D-22, CORE-09
    version: integer("version").notNull().default(1),                // D-30: optimistic locking
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),  // D-21
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),  // D-21
    verified_at: timestamp("verified_at", { withTimezone: true }),    // D-21, D-11
    archived_at: timestamp("archived_at", { withTimezone: true }),    // D-21, D-28
  },
  (table) => [
    index("memories_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")).with({ m: 16, ef_construction: 64 }),
    index("memories_project_id_idx").on(table.project_id),
    index("memories_author_idx").on(table.author),
    index("memories_type_idx").on(table.type),
    index("memories_created_at_idx").on(table.created_at),
  ]
);
