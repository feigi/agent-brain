ALTER TABLE "relationships" RENAME COLUMN "source" TO "created_via";--> statement-breakpoint
DROP INDEX "relationships_unique_edge";--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_unique_active_edge" ON "relationships" USING btree ("project_id","source_id","target_id","type") WHERE archived_at IS NULL;
