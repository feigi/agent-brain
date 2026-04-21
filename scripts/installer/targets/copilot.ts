import { join } from "node:path";
import type { Target, InstallPlan } from "../types.js";
import {
  checkJq,
  checkTargetDirWritable,
  checkDockerWarn,
} from "../preflight.js";

const HOOK_SCRIPTS = [
  "memory-session-start.sh",
  "memory-pretool.sh",
  "memory-session-end.sh",
];

export const copilotTarget: Target = {
  name: "copilot",

  async preflight() {
    await checkJq();
    const warn = await checkDockerWarn();
    if (warn) console.warn(`WARN: ${warn}`);
    await checkTargetDirWritable(`${process.env.HOME ?? ""}/.copilot`);
    await checkTargetDirWritable(`${process.env.HOME ?? ""}/.copilot/hooks`);
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
      target: "copilot",
      copies,
      jsonMerges: [
        {
          file: join(home, ".copilot", "mcp-config.json"),
          patch: { __fromFile: mcpSnippet },
        },
        {
          file: join(home, ".copilot", "hooks", "hooks.json"),
          patch: { __fromFile: hooksSnippet },
        },
      ],
      markdownPrepends: [
        {
          file: join(home, ".copilot", "copilot-instructions.md"),
          snippet: `__fromFile:${instructionsSnippet}`,
          markerId: "agent-brain",
        },
      ],
      postInstructions: [
        "Start the Agent Brain server:",
        "  docker compose -f docker-compose.prod.yml up -d --wait",
      ],
    };
  },

  describe(plan: InstallPlan): string {
    const lines: string[] = [`Target: ${plan.target}`];
    for (const c of plan.copies) lines.push(`  copy  ${c.src} → ${c.dest}`);
    for (const m of plan.jsonMerges) lines.push(`  merge ${m.file}`);
    for (const p of plan.markdownPrepends)
      lines.push(`  prepend ${p.file} [${p.markerId}]`);
    return lines.join("\n");
  },
};
