/**
 * One-time idempotent migration script: backfill relationships from existing flags.
 *
 * Maps:
 *   flag_type "duplicate"               → relationship type "duplicates"
 *   flag_type "superseded" | "override" → relationship type "overrides"
 *   flag_type "verify" | "contradiction" → skipped (no relationship mapping)
 *
 * Idempotency:
 *   - Skips flags that already have `relationship_id` in their details
 *   - Checks for existing relationships before inserting
 *
 * Historical relationships:
 *   - For flags with severity "auto_resolved", sets archived_at on the relationship
 *
 * Source/target convention (matches consolidation service):
 *   - source_id = relatedMemoryId (the newer/dominant memory)
 *   - target_id = flag.memory_id   (the flagged/superseded memory)
 */

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/index.js";
import { flags, relationships } from "../src/db/schema.js";
import { config } from "../src/config.js";
import { generateId } from "../src/utils/id.js";
import { logger } from "../src/utils/logger.js";

// ── Flag-type → relationship-type map ───────────────────────────────────────

const FLAG_TO_REL_TYPE: Partial<Record<string, string>> = {
  duplicate: "duplicates",
  superseded: "overrides",
  override: "overrides",
};

// ── Main ────────────────────────────────────────────────────────────────────

async function migrate() {
  const db = createDb(config.databaseUrl);
  logger.info("Starting flag → relationship migration…");

  const allFlags = await db.select().from(flags);

  let created = 0;
  let skippedAlreadyMigrated = 0;
  let skippedNoRelatedId = 0;
  let skippedNoMapping = 0;
  let skippedExistingRel = 0;
  let errors = 0;

  for (const flag of allFlags) {
    const details = flag.details as {
      related_memory_id?: string;
      similarity?: number;
      reason: string;
      relationship_id?: string;
    };

    // Idempotency: skip flags already processed by this migration
    if (details.relationship_id) {
      skippedAlreadyMigrated++;
      continue;
    }

    // Skip flags that have no related memory (e.g. "verify" flags)
    if (!details.related_memory_id) {
      skippedNoRelatedId++;
      continue;
    }

    // Skip flag types that don't map to any relationship type
    const relType = FLAG_TO_REL_TYPE[flag.flag_type];
    if (!relType) {
      skippedNoMapping++;
      continue;
    }

    const sourceId = details.related_memory_id;
    const targetId = flag.memory_id;

    try {
      // Check whether this exact relationship already exists
      const [existingRel] = await db
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          and(
            eq(relationships.project_id, flag.project_id),
            eq(relationships.source_id, sourceId),
            eq(relationships.target_id, targetId),
            eq(relationships.type, relType),
          ),
        )
        .limit(1);

      if (existingRel) {
        // Record the relationship_id on the flag for idempotency on future runs
        await db
          .update(flags)
          .set({
            details: {
              ...details,
              relationship_id: existingRel.id,
            } as typeof details,
          })
          .where(eq(flags.id, flag.id));
        skippedExistingRel++;
        continue;
      }

      // Create the relationship
      const relId = generateId();
      // auto_resolved flags represent already-handled historical relationships
      const archivedAt = flag.severity === "auto_resolved" ? new Date() : null;

      await db.insert(relationships).values({
        id: relId,
        project_id: flag.project_id,
        source_id: sourceId,
        target_id: targetId,
        type: relType,
        description: details.reason,
        confidence: details.similarity ?? 1.0,
        created_by: "migration",
        created_via: "consolidation",
        archived_at: archivedAt,
        created_at: flag.created_at,
      });

      // Stamp relationship_id onto flag details for idempotency
      await db
        .update(flags)
        .set({
          details: {
            ...details,
            relationship_id: relId,
          } as typeof details,
        })
        .where(eq(flags.id, flag.id));

      created++;
      logger.info(
        `  Created relationship ${relId} (${relType}) for flag ${flag.id} [${flag.flag_type}]`,
      );
    } catch (err) {
      logger.error(`  Failed to process flag ${flag.id}:`, err);
      errors++;
    }
  }

  logger.info("Migration complete:");
  logger.info(`  Created:                    ${created}`);
  logger.info(`  Skipped (already migrated): ${skippedAlreadyMigrated}`);
  logger.info(`  Skipped (existing rel):     ${skippedExistingRel}`);
  logger.info(`  Skipped (no related_id):    ${skippedNoRelatedId}`);
  logger.info(`  Skipped (no rel mapping):   ${skippedNoMapping}`);
  logger.info(`  Errors:                     ${errors}`);

  await db.$client.end();

  if (errors > 0) {
    process.exit(1);
  }
}

migrate().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
