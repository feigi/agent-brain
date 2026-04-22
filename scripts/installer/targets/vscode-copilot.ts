import { join } from "node:path";
import type { Target, InstallPlan } from "../types.js";
import { checkTargetDirWritable, checkDockerWarn } from "../preflight.js";
import { describePlan } from "./shared.js";

// VS Code stores user-level config under a platform-specific data directory.
// Windows is not supported (the installer relies on Unix shell tooling).
export function vscodeUserDataDir(home: string): string {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User");
  }
  return join(home, ".config", "Code", "User");
}

export const vscodeCopilotTarget: Target = {
  name: "vscode-copilot",

  async preflight(home: string) {
    // No jq check — VS Code has no shell hook scripts.
    const warn = await checkDockerWarn();
    if (warn) console.warn(`WARN: ${warn}`);
    await checkTargetDirWritable(vscodeUserDataDir(home));
  },

  plan(repoRoot: string, home: string): InstallPlan {
    const userDir = vscodeUserDataDir(home);
    const mcpSnippet = join(
      repoRoot,
      "hooks",
      "vscode-copilot",
      "mcp-snippet.json",
    );

    return {
      target: "vscode-copilot",
      copies: [],
      jsonMerges: [
        {
          file: join(userDir, "mcp.json"),
          patch: { kind: "file", path: mcpSnippet },
        },
      ],
      markdownPrepends: [],
      postInstructions: [
        "Start the Agent Brain server:",
        "  docker compose -f docker-compose.prod.yml up -d --wait",
        "For custom instructions, copy hooks/copilot/instructions-snippet.md",
        "into .github/copilot-instructions.md in each workspace.",
      ],
    };
  },

  describe: describePlan,
};
