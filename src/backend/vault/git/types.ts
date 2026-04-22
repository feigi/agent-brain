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
  isRepo(): Promise<boolean>;
  init(): Promise<void>;
  stageAndCommit(
    paths: string[],
    subject: string,
    trailer: CommitTrailer,
  ): Promise<void>;
  status(): Promise<{ clean: boolean }>;
}

export class NoopGitOps implements GitOps {
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
