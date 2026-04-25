// Phase 6 — shared types for both migration directions.

export const ENTITY_KINDS = [
  "workspaces",
  "memories",
  "comments",
  "flags",
  "relationships",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface MigrationOptions {
  vaultRoot: string;
  pgUrl: string;
  projectId: string;
  embeddingDimensions: number;
  reembed: boolean;
  verify: boolean;
  dryRun: boolean;
  trackUsersInGit: boolean;
}

export interface CountsByKind {
  workspaces: number;
  memories: number;
  comments: number;
  flags: number;
  relationships: number;
}

export interface MigrationReport {
  source: CountsByKind;
  destination: CountsByKind;
  reembedded: boolean;
  durationMs: number;
}

// Exit codes — also documented in the spec under D8.
export const EXIT = {
  OK: 0,
  PREFLIGHT: 1,
  VERIFY: 2,
  WRITE: 3,
  COMMIT_OR_PUSH: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
