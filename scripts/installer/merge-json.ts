import { readFile } from "node:fs/promises";
import { atomicWrite, fileExists, writeBackup } from "./fs-util.js";

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

function deepMerge(
  base: unknown,
  patch: unknown,
  keyPath: string[] = [],
): unknown {
  if (Array.isArray(base) && Array.isArray(patch)) {
    return dedupeArray([...base, ...patch]);
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const result: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      result[k] = k in base ? deepMerge(base[k], v, [...keyPath, k]) : v;
    }
    return result;
  }
  if (base !== undefined && typeof base !== typeof patch) {
    const path = keyPath.join(".") || "(root)";
    console.warn(
      `WARN: type mismatch at ${path}: replacing ${Array.isArray(base) ? "array" : typeof base} with ${Array.isArray(patch) ? "array" : typeof patch}`,
    );
  }
  return patch;
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

  if (existed) {
    const bak = await writeBackup(file);
    console.log(`Backup: ${bak}`);
  }

  await atomicWrite(file, JSON.stringify(merged, null, 2) + "\n");
}
