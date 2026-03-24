import { eq, and, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { sessionTracking, sessions } from "../db/schema.js";
import type { SessionTrackingRepository, SessionRepository } from "./types.js";
import { config } from "../config.js";

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

    const previousSession =
      existing.length > 0 ? existing[0].last_session_at : null;

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

// Phase 4: Session lifecycle repository for autonomous write budget tracking (D-18)
export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async createSession(
    id: string,
    userId: string,
    projectId: string,
  ): Promise<void> {
    await this.db.insert(sessions).values({
      id,
      user_id: userId,
      project_id: projectId,
    });
  }

  async getBudget(
    sessionId: string,
  ): Promise<{ used: number; limit: number } | null> {
    const result = await this.db
      .select({ budget_used: sessions.budget_used })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (result.length === 0) return null;
    return { used: result[0].budget_used, limit: config.writeBudgetPerSession };
  }

  async incrementBudgetUsed(
    sessionId: string,
    limit: number,
  ): Promise<{ used: number; exceeded: boolean }> {
    // Atomic increment: only increment if budget_used < limit (prevents race conditions)
    const result = await this.db
      .update(sessions)
      .set({ budget_used: sql`${sessions.budget_used} + 1` })
      .where(
        and(
          eq(sessions.id, sessionId),
          sql`${sessions.budget_used} < ${limit}`,
        ),
      )
      .returning({ budget_used: sessions.budget_used });

    if (result.length === 0) {
      // Budget already at limit -- read current value to return
      const current = await this.db
        .select({ budget_used: sessions.budget_used })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return { used: current[0]?.budget_used ?? limit, exceeded: true };
    }
    return { used: result[0].budget_used, exceeded: false };
  }

  async findById(sessionId: string): Promise<{
    id: string;
    user_id: string;
    project_id: string;
    budget_used: number;
  } | null> {
    const result = await this.db
      .select({
        id: sessions.id,
        user_id: sessions.user_id,
        project_id: sessions.project_id,
        budget_used: sessions.budget_used,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return result[0] ?? null;
  }
}
