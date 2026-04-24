import { join } from "node:path";
import { DomainError, NotFoundError } from "../../../utils/errors.js";
import { logger } from "../../../utils/logger.js";
import {
  parseMemoryFile,
  serializeMemoryFile,
  type ParsedMemoryFile,
} from "../parser/memory-parser.js";
import { readMarkdown, writeMarkdownAtomic } from "../io/vault-fs.js";
import { withFileLock } from "../io/lock.js";
import {
  VaultGitNothingToCommitError,
  type CommitTrailer,
  type GitOps,
} from "../git/types.js";
import { assertUsersIgnored } from "../git/users-gitignore-invariant.js";
import type { VaultIndex } from "./vault-index.js";

export interface VaultMemoryFilesConfig {
  root: string;
  gitOps: GitOps;
  vaultIndex: VaultIndex;
  // When false, user-scope mutations skip the commit (privacy) and
  // additionally assert .gitignore still lists `users/` so the rule
  // hasn't been removed while the assumption is still load-bearing.
  trackUsersInGit: boolean;
}

export class VaultParseError extends DomainError {
  constructor(
    public readonly relPath: string,
    public readonly cause: unknown,
  ) {
    super(
      `failed to parse memory file ${relPath}: ${describeCause(cause)}`,
      "VAULT_PARSE_ERROR",
      500,
    );
  }
}

// Shared id-to-path resolution + locked read-modify-write for every
// repository that persists inside a memory's markdown file.
// Path resolution is O(1) via the shared VaultIndex.
export class VaultMemoryFiles {
  constructor(private readonly cfg: VaultMemoryFilesConfig) {}

  async resolvePath(memoryId: string): Promise<string | null> {
    return this.cfg.vaultIndex.resolve(memoryId);
  }

  async read(memoryId: string): Promise<ParsedMemoryFile | null> {
    const rel = await this.resolvePath(memoryId);
    if (rel === null) return null;
    return await parseAt(this.cfg.root, rel);
  }

  // Throws NotFoundError if the memory has disappeared by the time the
  // lock is acquired — matches pg FK behavior.
  async edit<T>(
    memoryId: string,
    mutator: (parsed: ParsedMemoryFile) => {
      next: ParsedMemoryFile;
      result: T;
      commit?: { subject: string; trailer: CommitTrailer };
    },
  ): Promise<T> {
    const rel = await this.resolvePath(memoryId);
    if (rel === null) throw new NotFoundError("memory", memoryId);
    const abs = join(this.cfg.root, rel);
    return await withFileLock(abs, async () => {
      const raw = await readMarkdownOrNotFound(this.cfg.root, rel, memoryId);
      const parsed = parseOrRaise(raw, rel);
      // Privacy guard: if this is a user-scope memory and the caller
      // hasn't opted into tracking, assert the `users/` rule still
      // keeps the path out of the remote. Runs even for non-committing
      // edits so a broken .gitignore is caught before downstream
      // writers that do commit can leak.
      if (
        parsed.memory.scope === "user" &&
        !this.cfg.trackUsersInGit &&
        this.cfg.gitOps.enabled
      ) {
        await assertUsersIgnored(this.cfg.root);
      }
      const { next, result, commit } = mutator(parsed);
      if (next !== parsed) {
        await writeMarkdownAtomic(
          this.cfg.root,
          rel,
          serializeMemoryFile(next),
        );
        if (
          commit &&
          shouldCommit(parsed.memory.scope, this.cfg.trackUsersInGit)
        ) {
          try {
            await this.cfg.gitOps.stageAndCommit(
              [rel],
              commit.subject,
              commit.trailer,
            );
          } catch (err) {
            if (err instanceof VaultGitNothingToCommitError) {
              // Identical-content write; no history to record.
              logger.debug("vault git nothing to commit", {
                rel,
                action: commit.trailer.action,
              });
            } else {
              // Markdown is already durable; git is the audit trail.
              // Surface real failures so operators see the drift,
              // then continue — the user-facing op already succeeded.
              logger.error("vault git commit failed; markdown/git drift", {
                rel,
                action: commit.trailer.action,
                err,
              });
            }
          }
        }
      }
      return result;
    });
  }

  async listAllParsed(): Promise<
    Array<{ rel: string; parsed: ParsedMemoryFile }>
  > {
    const out: Array<{ rel: string; parsed: ParsedMemoryFile }> = [];
    for (const [, entry] of this.cfg.vaultIndex.entries()) {
      out.push({
        rel: entry.path,
        parsed: await parseAt(this.cfg.root, entry.path),
      });
    }
    return out;
  }
}

// User-scope writes only commit when the caller opted in; otherwise
// the path is gitignored and staging would no-op.
function shouldCommit(scope: string, trackUsersInGit: boolean): boolean {
  return scope !== "user" || trackUsersInGit;
}

async function parseAt(root: string, rel: string): Promise<ParsedMemoryFile> {
  const raw = await readMarkdown(root, rel);
  return parseOrRaise(raw, rel);
}

function parseOrRaise(raw: string, rel: string): ParsedMemoryFile {
  try {
    return parseMemoryFile(raw);
  } catch (err) {
    throw new VaultParseError(rel, err);
  }
}

async function readMarkdownOrNotFound(
  root: string,
  rel: string,
  memoryId: string,
): Promise<string> {
  try {
    return await readMarkdown(root, rel);
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) throw new NotFoundError("memory", memoryId);
    throw err;
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === code
  );
}

function describeCause(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
