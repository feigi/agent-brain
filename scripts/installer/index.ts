import { parseArgs } from "node:util";
import { createInterface as createLineReader } from "node:readline";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RunOptions, TargetName, Target } from "./types.js";
import { ALL_TARGET_NAMES } from "./types.js";
import { claudeTarget } from "./targets/claude.js";
import { copilotTarget } from "./targets/copilot.js";
import { vscodeCopilotTarget } from "./targets/vscode-copilot.js";
import { checkbox } from "./checkbox.js";
import { applyPlan } from "./apply.js";
import { uninstallTarget } from "./uninstall.js";
import { isDirectory } from "./fs-util.js";
import { bootstrapEnv } from "./env-file.js";

const TARGETS: Record<TargetName, Target> = {
  claude: claudeTarget,
  "copilot-cli": copilotTarget,
  "vscode-copilot": vscodeCopilotTarget,
};

export interface Env {
  repoRoot: string;
  home: string;
}

export async function runInstaller(opts: RunOptions, env: Env): Promise<void> {
  // Sync env.home into process.env.HOME: preflight helpers and downstream
  // tools (jq, docker) read it directly from the environment.
  process.env.HOME = env.home;

  for (const name of opts.targets) {
    await TARGETS[name].preflight(env.home);
  }

  if (!opts.uninstall && !opts.skipEnvBootstrap) {
    const { ask, close } = createStdinAsker();
    try {
      await bootstrapEnv(env.repoRoot, {
        dryRun: opts.dryRun,
        ask,
        log: (m) => console.log(m),
      });
    } finally {
      close();
    }
  }

  const seenPostLines = new Set<string>();
  const postInstructions: string[] = [];

  for (const name of opts.targets) {
    const target = TARGETS[name];
    if (opts.uninstall) {
      await uninstallTarget(target, env.repoRoot, env.home, {
        dryRun: opts.dryRun,
      });
      continue;
    }
    const plan = target.plan(env.repoRoot, env.home);
    if (opts.dryRun) {
      console.log(target.describe(plan));
      continue;
    }
    await applyPlan(plan, { dryRun: false });
    for (const line of plan.postInstructions) {
      if (!seenPostLines.has(line)) {
        seenPostLines.add(line);
        postInstructions.push(line);
      }
    }
  }

  for (const line of postInstructions) console.log(line);
}

// `readline/promises.question` rejects with ERR_USE_AFTER_CLOSE when the
// input stream EOFs between consecutive questions — which is exactly what
// `printf 'a\nb\n' | installer` does. Use classic readline's `line` event
// so queued questions still resolve with buffered lines (or "" after close).
interface StdinAsker {
  ask: (prompt: string) => Promise<string>;
  close: () => void;
}

function createStdinAsker(): StdinAsker {
  const rl = createLineReader({ input: stdin, terminal: false });
  const buffered: string[] = [];
  const waiters: Array<(v: string) => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter("");
  });

  return {
    ask: (prompt) => {
      stdout.write(prompt);
      if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
      if (closed) return Promise.resolve("");
      return new Promise<string>((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

function parseTargetList(input: string): TargetName[] {
  const parts = input.split(",").map((s) => s.trim());
  const valid = ALL_TARGET_NAMES as readonly string[];
  const invalid = parts.filter((p) => !valid.includes(p));
  if (invalid.length > 0 || parts.length === 0) {
    throw new Error(
      `Invalid target '${input}'. Expected: ${ALL_TARGET_NAMES.join(" | ")} | all (or comma-separated).`,
    );
  }
  return parts as TargetName[];
}

async function promptTarget(): Promise<TargetName[]> {
  return checkbox<TargetName>(
    "Select targets (space to toggle, enter to confirm):",
    ALL_TARGET_NAMES.map((name) => ({ label: name, value: name })),
  );
}

// HOME must be an absolute path to an existing directory and not filesystem
// root — otherwise targets would silently write into '/' or fail with a
// confusing EACCES after partial mkdir.
async function validateHome(home: string | undefined): Promise<string> {
  if (!home || home.trim() === "") {
    throw new Error("HOME environment variable is not set");
  }
  if (!isAbsolute(home)) {
    throw new Error(`HOME must be an absolute path, got '${home}'`);
  }
  if (home === "/") {
    throw new Error("HOME must not be filesystem root '/'");
  }
  if (!(await isDirectory(home))) {
    throw new Error(`HOME='${home}' is not an existing directory`);
  }
  return home;
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
      `Usage: npm run install:agent -- [--target=${ALL_TARGET_NAMES.join(",")}|all] [--dry-run] [--uninstall]`,
    );
    return;
  }

  let targets: TargetName[];
  if (values.target) {
    const t = String(values.target);
    if (t === "all") {
      targets = [...ALL_TARGET_NAMES];
    } else {
      targets = parseTargetList(t);
    }
  } else if (stdin.isTTY) {
    targets = await promptTarget();
  } else {
    throw new Error("--target required when not running interactively");
  }

  const home = await validateHome(process.env.HOME);

  await runInstaller(
    {
      targets,
      dryRun: Boolean(values["dry-run"]),
      uninstall: Boolean(values.uninstall),
    },
    {
      repoRoot: process.cwd(),
      home,
    },
  );
}

function formatError(err: unknown): string {
  const lines: string[] = [];
  let current: unknown = err;
  while (current) {
    const msg = current instanceof Error ? current.message : String(current);
    lines.push(lines.length === 0 ? msg : `  caused by: ${msg}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    lines.push(err.stack);
  }
  return lines.join("\n");
}

// Compare the real path of this module with the real path of the entry
// script. `endsWith` could match any suffix (including empty), which would
// fire main() on unrelated imports.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    return realpathSync(here) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`ERR: ${formatError(err)}`);
    process.exit(2);
  });
}
