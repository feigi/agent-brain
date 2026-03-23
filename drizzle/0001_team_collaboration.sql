SELECT pg_advisory_lock(42);--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"author" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_tracking" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"last_session_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_tracking_user_project_idx" UNIQUE("user_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "last_comment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tracking" ADD CONSTRAINT "session_tracking_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_memory_id_idx" ON "comments" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "comments_created_at_idx" ON "comments" USING btree ("created_at");--> statement-breakpoint
SELECT pg_advisory_unlock(42);
