CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('project', 'user');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('fact', 'decision', 'learning', 'pattern', 'preference', 'architecture');--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"content" text NOT NULL,
	"title" text NOT NULL,
	"type" "memory_type" NOT NULL,
	"scope" "memory_scope" DEFAULT 'project' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[],
	"author" text NOT NULL,
	"source" text,
	"session_id" text,
	"metadata" jsonb,
	"embedding" vector(768),
	"embedding_model" text,
	"embedding_dimensions" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "memories_project_id_idx" ON "memories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "memories_author_idx" ON "memories" USING btree ("author");--> statement-breakpoint
CREATE INDEX "memories_type_idx" ON "memories" USING btree ("type");--> statement-breakpoint
CREATE INDEX "memories_created_at_idx" ON "memories" USING btree ("created_at");