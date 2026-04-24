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
}

// How MemoryService.update constructs its diff argument — `logUpdate` takes
// opaque `Record<string, unknown>`, so the constraint really lives at the
// call site, not in AuditService.logUpdate's signature.
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

      const createdAt = new Date(iso);
      if (Number.isNaN(createdAt.getTime())) {
        logger.warn(
          `vault audit: skipping ${sha} with invalid created_at: ${iso}`,
        );
        continue;
      }

      let diff: Record<string, unknown> | null = null;
      let projectId = "";
      if (auditAction === "updated") {
        try {
          const result = await this.reconstructUpdateDiff(sha, memoryId);
          diff = result?.diffFields ?? null;
          projectId = result?.projectId ?? "";
        } catch (err) {
          logger.warn(
            `vault audit: failed to reconstruct diff for ${sha} ${memoryId}`,
            err,
          );
        }
      } else {
        projectId = await this.readProjectId(sha, memoryId);
      }

      entries.push({
        id: sha,
        project_id: projectId,
        memory_id: memoryId,
        action: auditAction,
        actor: trailers.actor,
        reason: trailers.reason ?? null,
        diff,
        created_at: createdAt,
      });
    }

    return entries.sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime(),
    );
  }

  private async reconstructUpdateDiff(
    sha: string,
    memoryId: string,
  ): Promise<{
    diffFields: { before: DiffFields; after: DiffFields };
    projectId: string;
  } | null> {
    const candidatePaths = await this.guessCandidatePaths(sha, memoryId);
    for (const path of candidatePaths) {
      const afterRaw = await this.safeShow(`${sha}:${path}`);
      if (afterRaw === null) continue;

      // Verify this blob belongs to the requested memory
      let after;
      try {
        after = parseMemoryFile(afterRaw).memory;
      } catch {
        logger.warn(
          `vault audit: failed to parse after-blob for ${sha}:${path}`,
        );
        continue;
      }
      if (after.id !== memoryId) continue;

      const beforeRaw = await this.safeShow(`${sha}^:${path}`);
      // No parent blob at this path means this is an update commit where the
      // file was first introduced on this branch (git shallow clone or orphan
      // lineage); skip the before/after reconstruction.
      if (beforeRaw === null) return null;

      let before;
      try {
        before = parseMemoryFile(beforeRaw).memory;
      } catch {
        logger.warn(
          `vault audit: failed to parse before-blob for ${sha}^:${path}`,
        );
        continue;
      }
      return {
        diffFields: {
          before: pickFields(before),
          after: pickFields(after),
        },
        projectId: after.project_id,
      };
    }
    return null;
  }

  // Read the project_id from the blob for the given memory at the given commit.
  // Uses diff-tree to find the actual path, then git show to read the blob.
  // Returns "" on any parse failure (clearly-invalid sentinel, unambiguous).
  private async readProjectId(sha: string, memoryId: string): Promise<string> {
    const candidatePaths = await this.guessCandidatePaths(sha, memoryId);
    for (const path of candidatePaths) {
      const raw = await this.safeShow(`${sha}:${path}`);
      if (raw === null) continue;
      try {
        const parsed = parseMemoryFile(raw);
        if (parsed.memory.id !== memoryId) continue;
        return parsed.memory.project_id;
      } catch {
        logger.warn(
          `vault audit: failed to parse memory blob for ${sha}:${path}`,
        );
        return "";
      }
    }
    return "";
  }

  // Produce candidate blob paths for a memory id. We use `git diff-tree`
  // (not `git show --name-only`) so the "show" mock in tests only ever
  // receives blob-like rev arguments.
  //
  // With title-based filenames the memory id is no longer part of the path,
  // so we return ALL .md paths touched by the commit and let the caller
  // verify the id via frontmatter parsing.
  //
  // If diff-tree fails or returns no matching path we return [] and let
  // reconstructUpdateDiff emit diff:null. We deliberately do NOT fall back
  // to a hardcoded heuristic path — workspace-scoped and user-scoped memories
  // live under different prefixes, so a wrong guess silently produces null
  // anyway but hides the real failure from logs.
  private async guessCandidatePaths(
    sha: string,
    memoryId: string,
  ): Promise<string[]> {
    try {
      // diff-tree lists paths changed by this commit. We pick any .md path
      // (the caller will verify the frontmatter id matches).
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
        if (p.endsWith(".md")) paths.push(p);
      }
      if (paths.length > 0) return paths;
      // diff-tree succeeded but found no matching .md path.
      logger.warn(
        `vault audit: diff-tree returned no .md path for ${sha} (memory ${memoryId})`,
      );
      return [];
    } catch (err) {
      // diff-tree unavailable (e.g. root commit) — log and return empty so
      // the caller emits diff:null rather than guessing a wrong path.
      logger.warn(`vault audit: diff-tree failed for ${sha} ${memoryId}`, err);
      return [];
    }
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
  } satisfies DiffFields;
}

function escapeRe(s: string): string {
  // Memory ids are nanoid-ish (alphanumeric-ish) but escape defensively.
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
