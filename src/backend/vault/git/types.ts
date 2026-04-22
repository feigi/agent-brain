import { DomainError } from "../../../utils/errors.js";

export type CommitAction =
  | "created"
  | "updated"
  | "archived"
  | "verified"
  | "commented"
  | "flagged"
  | "unflagged"
  | "related"
  | "unrelated"
  | "workspace_upsert";

export interface CommitTrailer {
  action: CommitAction;
  memoryId?: string;
  workspaceId?: string;
  actor: string;
  reason?: string | null;
}

export interface GitOps {
  // False for the no-op implementation used by test backends that
  // don't need a real git repo. Callers use this to skip privacy
  // guards and other git-only invariants when no commit will land.
  readonly enabled: boolean;
  isRepo(): Promise<boolean>;
  init(): Promise<void>;
  stageAndCommit(
    paths: string[],
    subject: string,
    trailer: CommitTrailer,
  ): Promise<void>;
  status(): Promise<{ clean: boolean }>;
}

// Thrown by stageAndCommit when `git add` staged nothing (file unchanged
// vs HEAD or path is gitignored). Callers can downgrade this case to
// debug while still surfacing real git failures.
export class VaultGitNothingToCommitError extends DomainError {
  constructor(paths: string[]) {
    super(
      `nothing to commit for paths: ${paths.join(", ")}`,
      "VAULT_GIT_NOTHING_TO_COMMIT",
      500,
    );
  }
}

export class NoopGitOps implements GitOps {
  readonly enabled = false;
  async isRepo(): Promise<boolean> {
    return false;
  }
  async init(): Promise<void> {}
  async stageAndCommit(): Promise<void> {}
  async status(): Promise<{ clean: boolean }> {
    return { clean: true };
  }
}

export const NOOP_GIT_OPS: GitOps = new NoopGitOps();
