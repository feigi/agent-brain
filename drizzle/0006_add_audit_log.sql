CREATE TYPE "public"."audit_action" AS ENUM('created', 'updated', 'archived', 'merged', 'flagged', 'commented');
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"action" "audit_action" NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"diff" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_log_memory_id_idx" ON "audit_log" USING btree ("memory_id");
