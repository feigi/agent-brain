import { rm, readFile } from "node:fs/promises";
import type { Target, InstallPlan } from "./types.js";
import { HOOK_SCRIPTS as CLAUDE_HOOKS } from "./targets/claude.js";
import { HOOK_SCRIPTS as COPILOT_HOOKS } from "./targets/copilot.js";
import { atomicWrite, fileExists, writeBackup } from "./fs-util.js";

function hookNamesFor(targetName: string): readonly string[] {
  if (targetName === "claude") return CLAUDE_HOOKS;
  if (targetName === "copilot") return COPILOT_HOOKS;
  return [];
}

function hookPathMatches(
  path: string,
  targetName: string,
  hookNames: readonly string[],
): boolean {
  const dirFragment =
    targetName === "claude" ? "/.claude/hooks/" : "/.copilot/hooks/";
  if (!path.includes(dirFragment)) return false;
  return hookNames.some((name) => path.endsWith(`/${name}`));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// An array item should be dropped when:
//  - its cleaned form is an agent-brain hook entry (command/bash points at one
//    of our scripts), or
//  - it was a non-empty object that stripping hollowed out to {} (e.g. a hook
//    group whose only key was a hooks array that got pruned), or
//  - it still carries an empty hooks: [] (group that started with empty hooks,
//    or a group the object-branch didn't prune for some reason).
function shouldDropArrayItem(
  original: unknown,
  cleaned: unknown,
  matchesHookPath: (p: string) => boolean,
): boolean {
  if (!isPlainObject(cleaned)) return false;

  const command = cleaned.command;
  if (typeof command === "string" && matchesHookPath(command)) return true;

  const bash = cleaned.bash;
  if (typeof bash === "string" && matchesHookPath(bash)) return true;

  const hooks = cleaned.hooks;
  if (Array.isArray(hooks) && hooks.length === 0) return true;

  const hollowed =
    Object.keys(cleaned).length === 0 &&
    isPlainObject(original) &&
    Object.keys(original).length > 0;
  return hollowed;
}

function stripAgentBrainFromJson(
  value: unknown,
  matchesHookPath: (p: string) => boolean,
): unknown {
  if (Array.isArray(value)) {
    const filtered: unknown[] = [];
    for (const item of value) {
      const cleaned = stripAgentBrainFromJson(item, matchesHookPath);
      if (shouldDropArrayItem(item, cleaned, matchesHookPath)) continue;
      filtered.push(cleaned);
    }
    return filtered;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "agent-brain") continue;
      const cleaned = stripAgentBrainFromJson(v, matchesHookPath);
      // Drop keys whose array value went empty as a result of stripping.
      // Preserves foreign keys that were already [] on entry.
      const arrayEmptied =
        Array.isArray(v) &&
        v.length > 0 &&
        Array.isArray(cleaned) &&
        cleaned.length === 0;
      if (arrayEmptied) continue;
      out[k] = cleaned;
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
  repoRoot: string,
  home: string,
  opts: { dryRun: boolean },
): Promise<void> {
  const plan: InstallPlan = target.plan(repoRoot, home);
  const hookNames = hookNamesFor(target.name);
  const matchesHookPath = (p: string): boolean =>
    hookPathMatches(p, target.name, hookNames);

  let incomplete = false;

  // Strip config references BEFORE removing the scripts. If config-strip fails,
  // re-running uninstall can still clean up. If we did it the other way, a
  // failure would leave dangling hook refs pointing at deleted files.
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `WARN: ${m.file}: invalid JSON (${msg}) — skipping clean. Restore manually or inspect .bak siblings.`,
      );
      incomplete = true;
      continue;
    }
    const stripped = stripAgentBrainFromJson(parsed, matchesHookPath);
    const bak = await writeBackup(m.file);
    console.log(`Backup: ${bak}`);
    await atomicWrite(m.file, JSON.stringify(stripped, null, 2) + "\n");
  }

  for (const p of plan.markdownPrepends) {
    if (!(await fileExists(p.file))) continue;
    if (opts.dryRun) {
      console.log(`[dry-run] strip markers in ${p.file}`);
      continue;
    }
    const content = await readFile(p.file, "utf8");
    const stripped = stripMarkerBlock(content, p.markerId);
    const bak = await writeBackup(p.file);
    console.log(`Backup: ${bak}`);
    await atomicWrite(p.file, stripped);
  }

  for (const c of plan.copies) {
    if (opts.dryRun) {
      console.log(`[dry-run] rm ${c.dest}`);
      continue;
    }
    try {
      await rm(c.dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`WARN: failed to remove ${c.dest}: ${msg}`);
      incomplete = true;
    }
  }

  console.log(
    `Uninstalled ${target.name}. If the server is running: docker compose down`,
  );

  if (incomplete) {
    process.exitCode = 3;
  }
}
