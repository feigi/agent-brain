import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

// Read a JSON file. Returns null on ENOENT or empty file. Rethrows
// other errors (EACCES, EISDIR, etc). Empty-file handling lets callers
// use an "ensure the lock target exists before writing" pattern.
export async function readJson<T>(
  root: string,
  relPath: string,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, relPath), "utf8");
  } catch (err: unknown) {
    if (isNodeCode(err, "ENOENT")) return null;
    throw err;
  }
  if (raw.length === 0) return null;
  return JSON.parse(raw) as T;
}

// Write a JSON file atomically (tmp + rename) — concurrent readers
// see either the old file or the new file, never a half-written one.
// Not crash-durable: no fsync on the fd or parent directory, so a
// power loss between rename and page-cache flush can lose the write.
export async function writeJsonAtomic(
  root: string,
  relPath: string,
  value: unknown,
): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// Write a JSON file that must not already exist (O_EXCL). Throws a
// Node error with `code === "EEXIST"` if the file is present; callers
// translate that to a domain error. Parent directories are created.
export async function writeJsonExclusive(
  root: string,
  relPath: string,
  value: unknown,
): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(value, null, 2), { flag: "wx" });
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

// Read a JSONL file and parse each non-empty line. Returns [] on ENOENT.
// appendJsonLine always terminates each entry with "\n", so any non-empty
// trailing chunk after the last newline means the writer crashed mid-line;
// we drop it rather than throw. Middle-of-file malformed lines still throw.
export async function readJsonLines<T>(
  root: string,
  relPath: string,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, relPath), "utf8");
  } catch (err: unknown) {
    if (isNodeCode(err, "ENOENT")) return [];
    throw err;
  }
  // split("\n") always produces N+1 elements where N = newline count.
  // If the file ended in "\n" the last element is "" (a normal terminator);
  // if it ended mid-line the last element is the partial content. Both
  // cases are discarded — empty via filter, partial via this slice.
  const candidates = raw.split("\n").slice(0, -1);
  return candidates
    .filter((l) => l.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`invalid JSONL entry at line ${i + 1} of ${relPath}`);
      }
    });
}

function isNodeCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === code
  );
}
