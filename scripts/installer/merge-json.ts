import { readFile, writeFile, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";

export interface MergeJsonOptions {
  dryRun: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dedupeArray(arr: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of arr) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(patch)) {
    return dedupeArray([...base, ...patch]);
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const result: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      result[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return result;
  }
  return patch;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function mergeJson(
  file: string,
  patch: unknown,
  opts: MergeJsonOptions,
): Promise<void> {
  const existed = await fileExists(file);
  let base: unknown = {};
  if (existed) {
    const raw = await readFile(file, "utf8");
    try {
      base = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${file}: invalid JSON (${msg}). Fix or delete before re-running.`,
        { cause: e },
      );
    }
  }

  const merged = deepMerge(base, patch);

  if (opts.dryRun) return;

  if (existed && !(await fileExists(`${file}.bak`))) {
    await copyFile(file, `${file}.bak`);
  }

  await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
