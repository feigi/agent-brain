import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { dirname, join } from "node:path";

// Read a JSON file. Returns null if the file is missing or empty
// (the latter covers the placeholder-then-lock pattern, where a
// zero-byte file is created so proper-lockfile has a target before
// the first write). Rethrows other errors (EACCES, EISDIR, etc).
export async function readJson<T>(
  root: string,
  relPath: string,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, relPath), "utf8");
  } catch (err: unknown) {
    if (isNodeEnoent(err)) return null;
    throw err;
  }
  if (raw.length === 0) return null;
  return JSON.parse(raw) as T;
}

// Write a JSON file atomically (tmp + rename). Callers hold the file
// lock; this helper just handles the serialize + atomic write.
export async function writeJsonAtomic(
  root: string,
  relPath: string,
  value: unknown,
): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, abs);
}

// Append a single JSON-encoded line (plus newline) to a JSONL file.
// Caller holds the file lock. Parent directories are created lazily.
export async function appendJsonLine(
  root: string,
  relPath: string,
  value: unknown,
): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await appendFile(abs, `${JSON.stringify(value)}\n`, "utf8");
}

// Read a JSONL file and parse each non-empty line. Returns [] if the
// file does not exist. A malformed line throws — we never silently drop.
export async function readJsonLines<T>(
  root: string,
  relPath: string,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, relPath), "utf8");
  } catch (err: unknown) {
    if (isNodeEnoent(err)) return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`invalid JSONL entry at line ${i + 1} of ${relPath}`);
      }
    });
}

function isNodeEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}
