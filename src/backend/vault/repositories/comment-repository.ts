import type { CommentRepository } from "../../../repositories/types.js";
import type { Comment } from "../../../types/memory.js";
import { VaultMemoryFiles } from "./memory-files.js";

export interface VaultCommentConfig {
  root: string;
}

export class VaultCommentRepository implements CommentRepository {
  private readonly files: VaultMemoryFiles;

  constructor(cfg: VaultCommentConfig) {
    this.files = new VaultMemoryFiles({ root: cfg.root });
  }

  async create(comment: {
    id: string;
    memory_id: string;
    author: string;
    content: string;
  }): Promise<Comment> {
    return await this.files.edit(comment.memory_id, (parsed) => {
      const now = new Date();
      const record: Comment = {
        id: comment.id,
        memory_id: comment.memory_id,
        author: comment.author,
        content: comment.content,
        created_at: now,
      };
      // Parity with DrizzleCommentRepository.create: bumps updated_at +
      // last_comment_at on the parent memory, but not version.
      const nextMemory = {
        ...parsed.memory,
        updated_at: now,
        last_comment_at: now,
      };
      return {
        parsed: {
          ...parsed,
          memory: nextMemory,
          comments: [...parsed.comments, record],
        },
        result: record,
      };
    });
  }

  async findByMemoryId(memoryId: string): Promise<Comment[]> {
    const parsed = await this.files.read(memoryId);
    if (!parsed) return [];
    return [...parsed.comments].sort(compareByCreatedAsc);
  }

  async findByMemoryIds(memoryIds: string[]): Promise<Comment[]> {
    if (memoryIds.length === 0) return [];
    const out: Comment[] = [];
    for (const id of memoryIds) {
      const parsed = await this.files.read(id);
      if (!parsed) continue;
      out.push(...parsed.comments);
    }
    return out.sort(compareByCreatedAsc);
  }

  async countByMemoryId(memoryId: string): Promise<number> {
    const parsed = await this.files.read(memoryId);
    return parsed?.comments.length ?? 0;
  }
}

function compareByCreatedAsc(a: Comment, b: Comment): number {
  return a.created_at.getTime() - b.created_at.getTime();
}
