import { eq, and, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { sessionTracking } from "../db/schema.js";
import type { SessionTrackingRepository } from "./types.js";

export class DrizzleSessionTrackingRepository implements SessionTrackingRepository {
  constructor(private readonly db: Database) {}

  // D-28: UPSERT session tracking. Returns previous last_session_at or null if first session.
  async upsert(userId: string, projectId: string): Promise<Date | null> {
    // First, get existing session timestamp
    const existing = await this.db
      .select({ last_session_at: sessionTracking.last_session_at })
      .from(sessionTracking)
      .where(
        and(
          eq(sessionTracking.user_id, userId),
          eq(sessionTracking.project_id, projectId),
        ),
      )
      .limit(1);

    const previousSession = existing.length > 0 ? existing[0].last_session_at : null;

    // UPSERT: insert or update last_session_at
    await this.db
      .insert(sessionTracking)
      .values({
        user_id: userId,
        project_id: projectId,
        last_session_at: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [sessionTracking.user_id, sessionTracking.project_id],
        set: { last_session_at: sql`now()` },
      });

    return previousSession;
  }
}
