import { z } from "zod";

// D-05, D-09: Slug validation for user_id and project_id
// Lowercase alphanumeric + hyphens, no leading/trailing hyphens, 1-64 chars
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 64;

export const slugSchema = z
  .string()
  .min(1, "Must not be empty")
  .max(SLUG_MAX_LENGTH, `Must be ${SLUG_MAX_LENGTH} characters or fewer`)
  .regex(
    SLUG_REGEX,
    "Must be lowercase alphanumeric with hyphens (e.g., 'my-project')",
  );

// D-75: Non-empty content validation for memory_create, memory_update, memory_comment
export const contentSchema = z
  .string()
  .trim()
  .min(1, "Content must not be empty or whitespace-only");

// D-17: Shared Zod enums for memory type and scope (single source of truth)
export const memoryTypeEnum = z.enum([
  "fact",
  "decision",
  "learning",
  "pattern",
  "preference",
  "architecture",
]);

export const memoryScopeEnum = z.enum(["workspace", "user", "project"]);

/** Parse cursor string (format: "created_at|id") into object for the repository layer */
export function parseCursor(
  cursor: string | undefined,
): { created_at: string; id: string } | undefined {
  if (!cursor) return undefined;
  const sep = cursor.indexOf("|");
  if (sep === -1) return undefined;
  return {
    created_at: cursor.slice(0, sep),
    id: cursor.slice(sep + 1),
  };
}
