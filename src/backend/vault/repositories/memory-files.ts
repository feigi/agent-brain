import { join } from "node:path";
import { DomainError, NotFoundError } from "../../../utils/errors.js";
import { logger } from "../../../utils/logger.js";
import {
  parseMemoryFile,
  serializeMemoryFile,
  type ParsedMemoryFile,
} from "../parser/memory-parser.js";
import { inferScopeFromPath } from "../io/paths.js";
import {
  listMarkdownFiles,
  readMarkdown,
  writeMarkdownAtomic,
} from "../io/vault-fs.js";
import { withFileLock } from "../io/lock.js";
import type { CommitTrailer, GitOps } from "../git/types.js";
import { NOOP_GIT_OPS } from "../git/types.js";

export interface VaultMemoryFilesConfig {
  root: string;
  gitOps?: GitOps;
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
// repository that persists inside a memory's markdown file. Scan-based
// lookup; no cross-repo index.
export class VaultMemoryFiles {
  private readonly gitOps: GitOps;
  constructor(private readonly cfg: VaultMemoryFilesConfig) {
    this.gitOps = cfg.gitOps ?? NOOP_GIT_OPS;
  }

  async resolvePath(memoryId: string): Promise<string | null> {
    const files = await safeListMd(this.cfg.root);
    for (const rel of files) {
      const loc = inferScopeFromPath(rel);
      if (loc?.id === memoryId) return rel;
    }
    return null;
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
      const { next, result, commit } = mutator(parsed);
      if (next !== parsed) {
        await writeMarkdownAtomic(
          this.cfg.root,
          rel,
          serializeMemoryFile(next),
        );
        if (commit) {
          try {
            await this.gitOps.stageAndCommit(
              [rel],
              commit.subject,
              commit.trailer,
            );
          } catch (err) {
            logger.warn("vault git commit failed; continuing", {
              rel,
              action: commit.trailer.action,
              err,
            });
          }
        }
      }
      return result;
    });
  }

  async listAllParsed(): Promise<
    Array<{ rel: string; parsed: ParsedMemoryFile }>
  > {
    const files = await safeListMd(this.cfg.root);
    const out: Array<{ rel: string; parsed: ParsedMemoryFile }> = [];
    for (const rel of files) {
      const loc = inferScopeFromPath(rel);
      if (loc === null) continue;
      out.push({ rel, parsed: await parseAt(this.cfg.root, rel) });
    }
    return out;
  }
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

async function safeListMd(root: string): Promise<string[]> {
  try {
    return await listMarkdownFiles(root);
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return [];
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
