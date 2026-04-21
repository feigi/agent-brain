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
  "memory-guard.sh",
  "memory-autofill.sh",
  "memory-nudge.sh",
  "memory-session-review.sh",
] as const;

export const claudeTarget: Target = {
  name: "claude",

  async preflight(home: string) {
    await checkJq();
    const warn = await checkDockerWarn();
    if (warn) console.warn(`WARN: ${warn}`);
    await checkTargetDirWritable(join(home, ".claude"));
    await checkTargetDirWritable(join(home, ".claude", "hooks"));
  },

  plan(repoRoot: string, home: string): InstallPlan {
    const hooksDir = join(home, ".claude", "hooks");
    const copies = HOOK_SCRIPTS.map((name) => ({
      src: join(repoRoot, "hooks", "claude", name),
      dest: join(hooksDir, name),
      mode: 0o755,
    }));

    const snippetPath = join(
      repoRoot,
      "hooks",
      "claude",
      "settings-snippet.json",
    );
    const mdSnippetPath = join(
      repoRoot,
      "hooks",
      "claude",
      "claude-md-snippet.md",
    );

    return {
      target: "claude",
      copies,
      jsonMerges: [
        {
          file: join(home, ".claude", "settings.json"),
          patch: { kind: "file", path: snippetPath },
        },
      ],
      markdownPrepends: [
        {
          file: join(home, ".claude", "CLAUDE.md"),
          snippet: { kind: "file", path: mdSnippetPath },
          markerId: makeMarkerId("agent-brain"),
        },
      ],
      postInstructions: [
        "Start the Agent Brain server:",
        "  docker compose -f docker-compose.prod.yml up -d --wait",
        "Override the MCP URL if needed: export AGENT_BRAIN_URL=http://host:port",
      ],
    };
  },

  describe: describePlan,
};
