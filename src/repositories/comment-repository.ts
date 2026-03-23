import { eq, asc, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { comments, memories } from "../db/schema.js";
import type { Comment } from "../types/memory.js";
import type { CommentRepository } from "./types.js";

export class DrizzleCommentRepository implements CommentRepository {
  constructor(private readonly db: Database) {}

  // D-53 + D-62: Comment creation + parent timestamp update in single transaction
  // D-54: Do NOT bump parent version
  async create(comment: { id: string; memory_id: string; author: string; content: string }): Promise<Comment> {
    return await this.db.transaction(async (tx) => {
      // Insert the comment
      const [inserted] = await tx
        .insert(comments)
        .values({
          id: comment.id,
          memory_id: comment.memory_id,
          author: comment.author,
          content: comment.content,
        })
        .returning();

      // Update parent memory timestamps (updated_at + last_comment_at) but NOT version
      await tx
        .update(memories)
        .set({
          updated_at: sql`now()`,
          last_comment_at: sql`now()`,
        })
        .where(eq(memories.id, comment.memory_id));

      return {
        id: inserted.id,
        memory_id: inserted.memory_id,
        author: inserted.author,
        content: inserted.content,
        created_at: inserted.created_at,
      };
    });
  }

  // D-64: Sorted oldest-first (chronological)
  async findByMemoryId(memoryId: string): Promise<Comment[]> {
    const result = await this.db
      .select()
      .from(comments)
      .where(eq(comments.memory_id, memoryId))
      .orderBy(asc(comments.created_at));

    return result.map((row) => ({
      id: row.id,
      memory_id: row.memory_id,
      author: row.author,
      content: row.content,
      created_at: row.created_at,
    }));
  }

  async countByMemoryId(memoryId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(comments)
      .where(eq(comments.memory_id, memoryId));
    return Number(result?.count ?? 0);
  }
}
