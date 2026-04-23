import type { SimpleGit } from "simple-git";
import type { AuditEntry } from "../../../types/audit.js";
import type { AuditAction } from "../../../types/audit.js";
import type { AuditRepository } from "../../../repositories/types.js";
import { parseTrailers } from "../git/trailer-parser.js";
import { parseMemoryFile } from "../parser/memory-parser.js";
import { safeSegment } from "../io/paths.js";
import type { CommitAction } from "../git/types.js";
import { logger } from "../../../utils/logger.js";

export interface VaultAuditConfig {
  root: string;
  git: SimpleGit;
  projectId: string;
}

// Five fields match what MemoryService.update passes to
// AuditService.logUpdate — keep in sync or the contract test will fail.
type DiffFields = Pick<
  ReturnType<typeof parseMemoryFile>["memory"],
  "content" | "title" | "type" | "tags" | "metadata"
>;

const UNIT = "\x1f"; // field separator
const RECORD = "\x1e"; // record separator

const TRAILER_TO_AUDIT: Partial<Record<CommitAction, AuditAction>> = {
  created: "created",
  updated: "updated",
  archived: "archived",
  commented: "commented",
  flagged: "flagged",
};

export class VaultAuditRepository implements AuditRepository {
  constructor(private readonly cfg: VaultAuditConfig) {}

  // create() still exists on the interface but the vault backend has no
  // state to write — git commits (with trailers) are the audit log.
  // Kept as a no-op so existing callers don't break.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async create(_entry: AuditEntry): Promise<void> {
    // intentional no-op
  }

  async findByMemoryId(memoryId: string): Promise<AuditEntry[]> {
    safeSegment(memoryId, "memory_id");
    // --grep on a fixed-anchored trailer line; --extended-regexp so `^`
    // and `$` apply per-line (the default is per-message).
    const raw = await this.cfg.git.raw([
      "log",
      "--all",
      "--extended-regexp",
      `--grep=^AB-Memory: ${escapeRe(memoryId)}$`,
      `--pretty=${"%H"}${UNIT}${"%aI"}${UNIT}${"%B"}${RECORD}`,
    ]);

    const records = raw
      .split(RECORD)
      .map((r) => r.trim())
      .filter((r) => r !== "");

    const entries: AuditEntry[] = [];
    for (const rec of records) {
      const [sha, iso, ...rest] = rec.split(UNIT);
      if (!sha || !iso || rest.length === 0) continue;
      const message = rest.join(UNIT);
      const trailers = parseTrailers(message);
      if (!trailers) continue;
      if (!("memoryId" in trailers) || trailers.memoryId !== memoryId) continue;
      const auditAction = TRAILER_TO_AUDIT[trailers.action];
      if (!auditAction) continue;

      let diff: Record<string, unknown> | null = null;
      if (auditAction === "updated") {
        try {
          diff = await this.reconstructUpdateDiff(sha, memoryId);
        } catch (err) {
          logger.warn(
            `vault audit: failed to reconstruct diff for ${sha} ${memoryId}`,
            err,
          );
        }
      }

      entries.push({
        id: sha,
        project_id: this.cfg.projectId,
        memory_id: memoryId,
        action: auditAction,
        actor: trailers.actor,
        reason: trailers.reason ?? null,
        diff,
        created_at: new Date(iso),
      });
    }

    return entries.sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime(),
    );
  }

  private async reconstructUpdateDiff(
    sha: string,
    memoryId: string,
  ): Promise<{ before: DiffFields; after: DiffFields } | null> {
    // Read the "after" blob first to determine the memory's scope and
    // workspace — we need the path to then read the "before" blob.
    // We probe the three known layout patterns; the first successful read wins.
    const candidatePaths = await this.guessCandidatePaths(sha, memoryId);
    for (const path of candidatePaths) {
      const afterRaw = await this.safeShow(`${sha}:${path}`);
      if (afterRaw === null) continue;

      const beforeRaw = await this.safeShow(`${sha}^:${path}`);
      if (beforeRaw === null) return null;

      const before = parseMemoryFile(beforeRaw).memory;
      const after = parseMemoryFile(afterRaw).memory;
      return {
        before: pickFields(before),
        after: pickFields(after),
      };
    }
    return null;
  }

  // Produce candidate blob paths for a memory id. We use `git diff-tree`
  // (not `git show --name-only`) so the "show" mock in tests only ever
  // receives blob-like rev arguments.
  private async guessCandidatePaths(
    sha: string,
    memoryId: string,
  ): Promise<string[]> {
    try {
      // diff-tree lists paths changed by this commit. We pick any path
      // that ends with `/<memoryId>.md`.
      const out = await this.cfg.git.raw([
        "diff-tree",
        "--no-commit-id",
        "-r",
        "--name-only",
        sha,
      ]);
      const paths: string[] = [];
      for (const line of out.split("\n")) {
        const p = line.trim();
        if (p.endsWith(`/${memoryId}.md`)) paths.push(p);
      }
      if (paths.length > 0) return paths;
    } catch {
      // diff-tree unavailable (e.g. root commit) — fall through to heuristic
    }
    // Heuristic fallback: return a wildcard-ish set of patterns so
    // safeShow probing works for common layouts.
    return [`project/memories/${memoryId}.md`];
  }

  private async safeShow(rev: string): Promise<string | null> {
    try {
      return await this.cfg.git.raw(["show", rev]);
    } catch {
      // First commit on a branch has no parent; git show returns
      // exit 128. Treat as "no parent blob" and skip diff.
      return null;
    }
  }
}

function pickFields(
  m: ReturnType<typeof parseMemoryFile>["memory"],
): DiffFields {
  return {
    content: m.content,
    title: m.title,
    type: m.type,
    tags: m.tags,
    metadata: m.metadata,
  } as DiffFields;
}

function escapeRe(s: string): string {
  // Memory ids are nanoid-ish (alphanumeric-ish) but escape defensively.
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
