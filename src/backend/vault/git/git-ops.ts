import { simpleGit, type SimpleGit } from "simple-git";
import { formatTrailers } from "./trailers.js";
import { scrubGitEnv } from "./env.js";
import {
  VaultGitNothingToCommitError,
  type CommitTrailer,
  type GitOps,
} from "./types.js";

export interface GitOpsConfig {
  root: string;
}

export class GitOpsImpl implements GitOps {
  readonly enabled = true;
  afterCommit?: () => void;
  private readonly git: SimpleGit;
  // Process-wide serialization of git index operations. Two writers
  // on different markdown files share one .git/index; without a
  // mutex, `git add A` + `git add B` + `git commit` can land both
  // files under the first writer's trailer (cross-attribution) or
  // race on `.git/index.lock`. The per-file lock in withFileLock
  // only protects markdown parity, not the index.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: GitOpsConfig) {
    // Inherited GIT_DIR / GIT_WORK_TREE (set by husky hooks, rebase, or
    // parent git commands) silently override baseDir and make every
    // operation target the outer repository. Strip them so cfg.root
    // always wins.
    this.git = simpleGit({ baseDir: cfg.root }).env(scrubGitEnv());
  }

  async isRepo(): Promise<boolean> {
    return await this.git.checkIsRepo();
  }

  async init(): Promise<void> {
    if (await this.isRepo()) return;
    await this.git.init();
  }

  async stageAndCommit(
    paths: string[],
    subject: string,
    trailer: CommitTrailer,
  ): Promise<void> {
    if (paths.length === 0) {
      throw new Error("stageAndCommit: paths must be non-empty");
    }
    await this.#serialize(async () => {
      await this.git.add(paths);
      const status = await this.git.status();
      if (status.staged.length === 0 && status.created.length === 0) {
        throw new VaultGitNothingToCommitError(paths);
      }
      const body = formatTrailers(trailer);
      // Scope the commit to the explicit paths so a concurrent writer
      // that sneaks into the index between our add and commit can't
      // land its file under our trailer.
      await this.git.commit(`${subject}\n\n${body}`, paths);
    });
    // Fire hook after the serialized block resolves so a callback that
    // itself calls into git cannot deadlock on the mutex. Swallow hook
    // errors — this is fire-and-forget.
    try {
      this.afterCommit?.();
    } catch {
      // ignored
    }
  }

  async status(): Promise<{ clean: boolean }> {
    const s = await this.git.status();
    return { clean: s.files.length === 0 };
  }

  // Serializes fn against every other call on this instance so
  // successive `git add` / `git commit` pairs run without interleaving.
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    // Preserve chain ordering even if fn rejects — swallow the error
    // here; the outer `next` still rejects to the caller.
    this.chain = next.catch(() => undefined);
    return next;
  }
}
