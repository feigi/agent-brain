import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { RunOptions, TargetName, Target } from "./types.js";
import { claudeTarget } from "./targets/claude.js";
import { copilotTarget } from "./targets/copilot.js";
import { applyPlan } from "./apply.js";
import { uninstallTarget } from "./uninstall.js";

const TARGETS: Record<TargetName, Target> = {
  claude: claudeTarget,
  copilot: copilotTarget,
};

export interface Env {
  repoRoot: string;
  home: string;
}

export async function runInstaller(opts: RunOptions, env: Env): Promise<void> {
  // Preflight all targets before any apply
  process.env.HOME = env.home;
  for (const name of opts.targets) {
    await TARGETS[name].preflight();
  }

  for (const name of opts.targets) {
    const target = TARGETS[name];
    if (opts.uninstall) {
      await uninstallTarget(target, env.home, { dryRun: opts.dryRun });
      continue;
    }
    const plan = target.plan(env.repoRoot, env.home);
    if (opts.dryRun) {
      console.log(target.describe(plan));
      continue;
    }
    await applyPlan(plan, { dryRun: false });
    for (const line of plan.postInstructions) console.log(line);
  }
}

async function promptTarget(): Promise<TargetName[]> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question("Target (claude/copilot/both)? "))
    .trim()
    .toLowerCase();
  rl.close();
  if (answer === "claude" || answer === "copilot") return [answer];
  if (answer === "both") return ["claude", "copilot"];
  throw new Error(`Invalid target: ${answer}`);
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      uninstall: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(
      `Usage: npm run install:agent -- [--target=claude|copilot|both] [--dry-run] [--uninstall]`,
    );
    return;
  }

  let targets: TargetName[];
  if (values.target) {
    const t = String(values.target);
    if (t === "claude" || t === "copilot") targets = [t];
    else if (t === "both") targets = ["claude", "copilot"];
    else throw new Error(`Invalid --target: ${t}`);
  } else if (stdin.isTTY) {
    targets = await promptTarget();
  } else {
    throw new Error("--target required when not running interactively");
  }

  if (!process.env.HOME) {
    throw new Error("HOME environment variable is not set");
  }

  await runInstaller(
    {
      targets,
      dryRun: Boolean(values["dry-run"]),
      uninstall: Boolean(values.uninstall),
    },
    {
      repoRoot: process.cwd(),
      home: process.env.HOME,
    },
  );
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isMain) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERR: ${msg}`);
    process.exit(2);
  });
}
