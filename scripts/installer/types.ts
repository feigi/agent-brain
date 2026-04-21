export type TargetName = "claude" | "copilot";

export interface CopyAction {
  src: string;
  dest: string;
  mode?: number;
}

export interface JsonMergeAction {
  file: string;
  patch: unknown;
}

export interface MarkdownPrependAction {
  file: string;
  snippet: string;
  markerId: string;
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
  preflight(): Promise<void>;
  plan(repoRoot: string, home: string): InstallPlan;
  describe(plan: InstallPlan): string;
}

export interface RunOptions {
  dryRun: boolean;
  yes: boolean;
  uninstall: boolean;
  targets: TargetName[];
}
