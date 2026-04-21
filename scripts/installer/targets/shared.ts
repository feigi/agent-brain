import type { InstallPlan } from "../types.js";

export function describePlan(plan: InstallPlan): string {
  const lines: string[] = [`Target: ${plan.target}`];
  for (const c of plan.copies) lines.push(`  copy  ${c.src} → ${c.dest}`);
  for (const m of plan.jsonMerges) lines.push(`  merge ${m.file}`);
  for (const p of plan.markdownPrepends)
    lines.push(`  prepend ${p.file} [${p.markerId}]`);
  return lines.join("\n");
}
