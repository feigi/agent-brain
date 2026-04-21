import { mkdir, copyFile, chmod, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InstallPlan } from "./types.js";
import { mergeJson } from "./merge-json.js";
import { prependWithMarkers } from "./merge-markdown.js";

export interface ApplyOptions {
  dryRun: boolean;
}

async function resolvePatch(patch: unknown): Promise<unknown> {
  if (
    typeof patch === "object" &&
    patch !== null &&
    !Array.isArray(patch) &&
    "__fromFile" in patch &&
    typeof (patch as { __fromFile: unknown }).__fromFile === "string"
  ) {
    const raw = await readFile(
      (patch as { __fromFile: string }).__fromFile,
      "utf8",
    );
    return JSON.parse(raw);
  }
  return patch;
}

async function resolveSnippet(snippet: string): Promise<string> {
  if (snippet.startsWith("__fromFile:")) {
    return readFile(snippet.slice("__fromFile:".length), "utf8");
  }
  return snippet;
}

export async function applyPlan(
  plan: InstallPlan,
  opts: ApplyOptions,
): Promise<void> {
  for (const c of plan.copies) {
    if (opts.dryRun) {
      console.log(`[dry-run] copy ${c.src} → ${c.dest}`);
      continue;
    }
    await mkdir(dirname(c.dest), { recursive: true });
    await copyFile(c.src, c.dest);
    if (c.mode !== undefined) await chmod(c.dest, c.mode);
  }

  for (const m of plan.jsonMerges) {
    const patch = await resolvePatch(m.patch);
    if (opts.dryRun) {
      console.log(`[dry-run] merge ${m.file}`);
      continue;
    }
    await mkdir(dirname(m.file), { recursive: true });
    await mergeJson(m.file, patch, { dryRun: false });
  }

  for (const p of plan.markdownPrepends) {
    const snippet = await resolveSnippet(p.snippet);
    if (opts.dryRun) {
      console.log(`[dry-run] prepend ${p.file} [${p.markerId}]`);
      continue;
    }
    await mkdir(dirname(p.file), { recursive: true });
    await prependWithMarkers(p.file, snippet, p.markerId, { dryRun: false });
  }
}
