import { join } from "node:path";
import type { Target, InstallPlan } from "../types.js";
import { makeMarkerId } from "../types.js";
import {
  checkJq,
  checkTargetDirWritable,
  checkDockerWarn,
} from "../preflight.js";
import { describePlan } from "./shared.js";

export const HOOK_SCRIPTS = [
  "memory-session-start.sh",
  "memory-pretool.sh",
  "memory-session-end.sh",
] as const;

export const copilotTarget: Target = {
  name: "copilot-cli",

  async preflight(home: string) {
    await checkJq();
    const warn = await checkDockerWarn();
    if (warn) console.warn(`WARN: ${warn}`);
    await checkTargetDirWritable(join(home, ".copilot"));
    await checkTargetDirWritable(join(home, ".copilot", "hooks"));
  },

  plan(repoRoot: string, home: string): InstallPlan {
    const hooksDir = join(home, ".copilot", "hooks");
    const copies = HOOK_SCRIPTS.map((name) => ({
      src: join(repoRoot, "hooks", "copilot", name),
      dest: join(hooksDir, name),
      mode: 0o755,
    }));

    const mcpSnippet = join(repoRoot, "hooks", "copilot", "mcp-snippet.json");
    const hooksSnippet = join(repoRoot, "hooks", "copilot", "hooks.json");
    const instructionsSnippet = join(
      repoRoot,
      "hooks",
      "copilot",
      "instructions-snippet.md",
    );

    return {
      target: "copilot-cli",
      copies,
      jsonMerges: [
        {
          file: join(home, ".copilot", "mcp-config.json"),
          patch: { kind: "file", path: mcpSnippet },
        },
        {
          file: join(home, ".copilot", "hooks", "hooks.json"),
          patch: { kind: "file", path: hooksSnippet },
        },
      ],
      markdownPrepends: [
        {
          file: join(home, ".copilot", "copilot-instructions.md"),
          snippet: { kind: "file", path: instructionsSnippet },
          markerId: makeMarkerId("agent-brain"),
        },
      ],
      postInstructions: [
        "Start the Agent Brain server:",
        "  docker compose -f docker-compose.prod.yml up -d --wait",
      ],
    };
  },

  describe: describePlan,
};
