import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Target, InstallPlan } from "../types.js";
import {
  checkJq,
  checkTargetDirWritable,
  checkDockerWarn,
} from "../preflight.js";

const HOOK_SCRIPTS = [
  "memory-session-start.sh",
  "memory-guard.sh",
  "memory-autofill.sh",
  "memory-nudge.sh",
  "memory-session-review.sh",
];

export const claudeTarget: Target = {
  name: "claude",

  async preflight() {
    await checkJq();
    const warn = await checkDockerWarn();
    if (warn) console.warn(`WARN: ${warn}`);
    await checkTargetDirWritable(`${process.env.HOME ?? ""}/.claude`);
    await checkTargetDirWritable(`${process.env.HOME ?? ""}/.claude/hooks`);
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
          patch: { __fromFile: snippetPath },
        },
      ],
      markdownPrepends: [
        {
          file: join(home, ".claude", "CLAUDE.md"),
          snippet: `__fromFile:${mdSnippetPath}`,
          markerId: "agent-brain",
        },
      ],
      postInstructions: [
        "Start the Agent Brain server:",
        "  docker compose -f docker-compose.prod.yml up -d --wait",
        "Override the MCP URL if needed: export AGENT_BRAIN_URL=http://host:port",
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

export async function loadSnippetJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

export async function loadSnippetText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
