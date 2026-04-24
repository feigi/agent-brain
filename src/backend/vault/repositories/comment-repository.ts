import type { CommentRepository } from "../../../repositories/types.js";
import type { Comment } from "../../../types/memory.js";
import type { GitOps } from "../git/types.js";
import type { VaultIndex } from "./vault-index.js";
import { VaultMemoryFiles } from "./memory-files.js";
import { commitSubject, compareByCreatedAsc } from "./util.js";

export interface VaultCommentConfig {
  root: string;
  gitOps: GitOps;
  trackUsersInGit?: boolean;
  vaultIndex: VaultIndex;
}

export class VaultCommentRepository implements CommentRepository {
  private readonly files: VaultMemoryFiles;

  constructor(cfg: VaultCommentConfig) {
    this.files = new VaultMemoryFiles({
      root: cfg.root,
      gitOps: cfg.gitOps,
      trackUsersInGit: cfg.trackUsersInGit ?? false,
      vaultIndex: cfg.vaultIndex,
    });
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
      // last_comment_at is derived from comments[] on read, so only
      // updated_at needs bumping here (matches pg's no-version-bump).
      const nextMemory = { ...parsed.memory, updated_at: now };
      return {
        next: {
          ...parsed,
          memory: nextMemory,
          comments: [...parsed.comments, record],
        },
        result: record,
        commit: {
          subject: commitSubject("commented", parsed.memory.title),
          trailer: {
            action: "commented",
            memoryId: parsed.memory.id,
            actor: comment.author,
          },
        },
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
