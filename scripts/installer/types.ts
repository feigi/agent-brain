export type TargetName = "claude" | "copilot";

export type MarkerId = string & { readonly __brand: "MarkerId" };

const MARKER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function makeMarkerId(id: string): MarkerId {
  if (!MARKER_ID_RE.test(id)) {
    throw new Error(
      `Invalid markerId '${id}': must match ${MARKER_ID_RE.source}`,
    );
  }
  return id as MarkerId;
}

export type Source<T> =
  | { kind: "inline"; value: T }
  | { kind: "file"; path: string };

export interface CopyAction {
  src: string;
  dest: string;
  mode?: number;
}

export interface JsonMergeAction {
  file: string;
  patch: Source<unknown>;
}

export interface MarkdownPrependAction {
  file: string;
  snippet: Source<string>;
  markerId: MarkerId;
}

export interface InstallPlan {
  target: TargetName;
  copies: CopyAction[];
  jsonMerges: JsonMergeAction[];
  markdownPrepends: MarkdownPrependAction[];
  postInstructions: string[];
}

export interface Target {
  name: TargetName;
  preflight(home: string): Promise<void>;
  plan(repoRoot: string, home: string): InstallPlan;
  describe(plan: InstallPlan): string;
}

export interface RunOptions {
  dryRun: boolean;
  uninstall: boolean;
  targets: TargetName[];
  // Test escape hatch: skip the repo-root `.env` bootstrap step.
  skipEnvBootstrap?: boolean;
}
