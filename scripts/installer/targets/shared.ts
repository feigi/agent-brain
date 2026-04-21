import type { InstallPlan } from "../types.js";

export function describePlan(plan: InstallPlan): string {
  const lines: string[] = [`Target: ${plan.target}`];
  for (const c of plan.copies) lines.push(`  copy  ${c.src} → ${c.dest}`);
  for (const m of plan.jsonMerges) {
    const src = m.patch.kind === "file" ? ` (from ${m.patch.path})` : "";
    lines.push(`  merge ${m.file}${src}`);
  }
  for (const p of plan.markdownPrepends) {
    const src = p.snippet.kind === "file" ? ` (from ${p.snippet.path})` : "";
    lines.push(`  prepend ${p.file} [${p.markerId}]${src}`);
  }
  return lines.join("\n");
}
