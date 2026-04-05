CREATE TYPE "public"."flag_severity" AS ENUM('auto_resolved', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."flag_type" AS ENUM('duplicate', 'contradiction', 'override', 'superseded', 'verify');--> statement-breakpoint
CREATE TABLE "flags" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"flag_type" "flag_type" NOT NULL,
	"severity" "flag_severity" NOT NULL,
	"details" jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flags_memory_id_idx" ON "flags" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "flags_severity_resolved_idx" ON "flags" USING btree ("severity","resolved_at");