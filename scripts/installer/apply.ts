import { mkdir, copyFile, chmod, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InstallPlan, Source } from "./types.js";
import { mergeJson } from "./merge-json.js";
import { prependWithMarkers } from "./merge-markdown.js";

export interface ApplyOptions {
  dryRun: boolean;
}

// Source<T> defers file reads to apply-time so plan() stays pure and dry-run avoids I/O.
async function resolvePatch(src: Source<unknown>): Promise<unknown> {
  if (src.kind === "inline") return src.value;
  const raw = await readFile(src.path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${src.path}: invalid JSON in snippet`, { cause: e });
  }
}

async function resolveSnippet(src: Source<string>): Promise<string> {
  if (src.kind === "inline") return src.value;
  return readFile(src.path, "utf8");
}

export async function applyPlan(
  plan: InstallPlan,
  opts: ApplyOptions,
): Promise<void> {
  const applied: string[] = [];
  try {
    for (const c of plan.copies) {
      if (opts.dryRun) {
        console.log(`[dry-run] copy ${c.src} → ${c.dest}`);
        continue;
      }
      await mkdir(dirname(c.dest), { recursive: true });
      await copyFile(c.src, c.dest);
      if (c.mode !== undefined) await chmod(c.dest, c.mode);
      applied.push(c.dest);
    }

    for (const m of plan.jsonMerges) {
      const patch = await resolvePatch(m.patch);
      if (opts.dryRun) {
        console.log(`[dry-run] merge ${m.file}`);
        continue;
      }
      await mkdir(dirname(m.file), { recursive: true });
      await mergeJson(m.file, patch, { dryRun: false });
      applied.push(m.file);
    }

    for (const p of plan.markdownPrepends) {
      const snippet = await resolveSnippet(p.snippet);
      if (opts.dryRun) {
        console.log(`[dry-run] prepend ${p.file} [${p.markerId}]`);
        continue;
      }
      await mkdir(dirname(p.file), { recursive: true });
      await prependWithMarkers(p.file, snippet, p.markerId, { dryRun: false });
      applied.push(p.file);
    }
  } catch (e) {
    if (applied.length > 0) {
      console.error("Partially applied. These files were modified:");
      for (const f of applied) console.error(`  ${f}`);
      console.error("Re-run to reconcile, or restore from .bak siblings.");
    }
    throw e;
  }
}
