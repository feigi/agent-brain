import { rm, readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import type { Target, InstallPlan } from "./types.js";

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function stripAgentBrainFromJson(
  value: unknown,
  hookPathPattern: RegExp,
): unknown {
  if (Array.isArray(value)) {
    const filtered: unknown[] = [];
    for (const item of value) {
      const cleaned = stripAgentBrainFromJson(item, hookPathPattern);
      if (
        cleaned !== null &&
        typeof cleaned === "object" &&
        !Array.isArray(cleaned) &&
        "hooks" in (cleaned as Record<string, unknown>) &&
        Array.isArray((cleaned as { hooks: unknown[] }).hooks) &&
        (cleaned as { hooks: unknown[] }).hooks.length === 0
      ) {
        continue;
      }
      if (
        cleaned !== null &&
        typeof cleaned === "object" &&
        !Array.isArray(cleaned) &&
        typeof (cleaned as { command?: unknown }).command === "string" &&
        hookPathPattern.test((cleaned as { command: string }).command)
      ) {
        continue;
      }
      if (
        cleaned !== null &&
        typeof cleaned === "object" &&
        !Array.isArray(cleaned) &&
        typeof (cleaned as { bash?: unknown }).bash === "string" &&
        hookPathPattern.test((cleaned as { bash: string }).bash)
      ) {
        continue;
      }
      filtered.push(cleaned);
    }
    return filtered;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "agent-brain") continue;
      out[k] = stripAgentBrainFromJson(v, hookPathPattern);
    }
    return out;
  }
  return value;
}

function stripMarkerBlock(content: string, id: string): string {
  const start = `<!-- ${id}:start -->`;
  const end = `<!-- ${id}:end -->`;
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1 || e < s) return content;
  const afterRaw = content.slice(e + end.length);
  const after = afterRaw.startsWith("\n") ? afterRaw.slice(1) : afterRaw;
  return content.slice(0, s) + after;
}

export async function uninstallTarget(
  target: Target,
  home: string,
  opts: { dryRun: boolean },
): Promise<void> {
  const plan: InstallPlan = target.plan(process.cwd(), home);
  const hookPathPattern = /memory-[a-z-]+\.sh/;

  for (const c of plan.copies) {
    if (opts.dryRun) {
      console.log(`[dry-run] rm ${c.dest}`);
      continue;
    }
    await rm(c.dest, { force: true });
  }

  for (const m of plan.jsonMerges) {
    if (!(await fileExists(m.file))) continue;
    if (opts.dryRun) {
      console.log(`[dry-run] clean ${m.file}`);
      continue;
    }
    const raw = await readFile(m.file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const stripped = stripAgentBrainFromJson(parsed, hookPathPattern);
    await writeFile(m.file, JSON.stringify(stripped, null, 2) + "\n", "utf8");
  }

  for (const p of plan.markdownPrepends) {
    if (!(await fileExists(p.file))) continue;
    if (opts.dryRun) {
      console.log(`[dry-run] strip markers in ${p.file}`);
      continue;
    }
    const content = await readFile(p.file, "utf8");
    const stripped = stripMarkerBlock(content, p.markerId);
    await writeFile(p.file, stripped, "utf8");
  }

  console.log(
    `Uninstalled ${target.name}. If the server is running: docker compose down`,
  );
}
