import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { projects } from "../db/schema.js";
import type { ProjectRepository } from "./types.js";

// D-34: Auto-create projects on first mention
export class DrizzleProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database) {}

  async findOrCreate(slug: string): Promise<{ id: string; created_at: Date }> {
    // Try to find existing project first
    const existing = await this.db
      .select({ id: projects.id, created_at: projects.created_at })
      .from(projects)
      .where(eq(projects.id, slug))
      .limit(1);

    if (existing.length > 0) {
      return existing[0];
    }

    // Auto-create on first mention
    const inserted = await this.db
      .insert(projects)
      .values({ id: slug })
      .onConflictDoNothing()
      .returning({ id: projects.id, created_at: projects.created_at });

    // Handle race condition: if insert was a no-op due to conflict, re-select
    if (inserted.length === 0) {
      const raceResult = await this.db
        .select({ id: projects.id, created_at: projects.created_at })
        .from(projects)
        .where(eq(projects.id, slug))
        .limit(1);
      return raceResult[0];
    }

    return inserted[0];
  }

  async findById(
    slug: string,
  ): Promise<{ id: string; created_at: Date } | null> {
    const result = await this.db
      .select({ id: projects.id, created_at: projects.created_at })
      .from(projects)
      .where(eq(projects.id, slug))
      .limit(1);

    return result.length > 0 ? result[0] : null;
  }
}
