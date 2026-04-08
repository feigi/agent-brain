CREATE TABLE "relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"source" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationships_no_self_ref" CHECK (source_id != target_id)
);
--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_id_memories_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_target_id_memories_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_unique_edge" ON "relationships" USING btree ("project_id","source_id","target_id","type");--> statement-breakpoint
CREATE INDEX "relationships_source_idx" ON "relationships" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "relationships_target_idx" ON "relationships" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "relationships_project_type_idx" ON "relationships" USING btree ("project_id","type");