import { simpleGit, type SimpleGit } from "simple-git";
import { formatTrailers } from "./trailers.js";
import { scrubGitEnv } from "./env.js";
import type { CommitTrailer, GitOps } from "./types.js";

export interface GitOpsConfig {
  root: string;
}

export class GitOpsImpl implements GitOps {
  private readonly git: SimpleGit;
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
    await this.git.add(paths);
    const status = await this.git.status();
    if (status.staged.length === 0 && status.created.length === 0) {
      // Staged set is empty — either nothing changed, or the file was
      // identical to HEAD. Treat as an error so the caller sees why
      // the commit did not happen (tests cover the duplicate-write case).
      throw new Error("nothing to commit");
    }
    const body = formatTrailers(trailer);
    await this.git.commit(`${subject}\n\n${body}`);
  }

  async status(): Promise<{ clean: boolean }> {
    const s = await this.git.status();
    return { clean: s.files.length === 0 };
  }
}
