import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import type { WorkspaceRepository } from "./types.js";

// D-34: Auto-create workspaces on first mention
export class DrizzleWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: Database) {}

  async findOrCreate(slug: string): Promise<{ id: string; created_at: Date }> {
    // Try to find existing workspace first
    const existing = await this.db
      .select({ id: workspaces.id, created_at: workspaces.created_at })
      .from(workspaces)
      .where(eq(workspaces.id, slug))
      .limit(1);

    if (existing.length > 0) {
      return existing[0];
    }

    // Auto-create on first mention
    const inserted = await this.db
      .insert(workspaces)
      .values({ id: slug })
      .onConflictDoNothing()
      .returning({ id: workspaces.id, created_at: workspaces.created_at });

    // Handle race condition: if insert was a no-op due to conflict, re-select
    if (inserted.length === 0) {
      const raceResult = await this.db
        .select({ id: workspaces.id, created_at: workspaces.created_at })
        .from(workspaces)
        .where(eq(workspaces.id, slug))
        .limit(1);
      return raceResult[0];
    }

    return inserted[0];
  }

  async findById(
    slug: string,
  ): Promise<{ id: string; created_at: Date } | null> {
    const result = await this.db
      .select({ id: workspaces.id, created_at: workspaces.created_at })
      .from(workspaces)
      .where(eq(workspaces.id, slug))
      .limit(1);

    return result.length > 0 ? result[0] : null;
  }
}
