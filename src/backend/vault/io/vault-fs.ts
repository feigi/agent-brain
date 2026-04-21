import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep, posix } from "node:path";

// Write a markdown file atomically: write to a sibling .tmp then rename.
// rename(2) is atomic on the same filesystem on POSIX and reasonably
// atomic on modern Windows — readers never see a half-written file.
export async function writeMarkdownAtomic(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, abs);
}

export async function readMarkdown(
  root: string,
  relPath: string,
): Promise<string> {
  return await readFile(join(root, relPath), "utf8");
}

export async function deleteMarkdown(
  root: string,
  relPath: string,
): Promise<void> {
  await rm(join(root, relPath));
}

export async function ensureParentDir(abs: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
}

// Ensure a file exists so proper-lockfile has a target. Creates parent
// directories and a zero-byte file if missing; EEXIST is swallowed as
// a racing creator won.
export async function ensureFileExists(abs: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  try {
    await writeFile(abs, "", { flag: "wx" });
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "EEXIST"
    )
      return;
    throw err;
  }
}

// Recursively list all *.md files under root, returning POSIX-style
// relative paths so callers can concatenate with `/` portably.
export async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const rel = relative(root, abs);
        out.push(sep === posix.sep ? rel : rel.split(sep).join(posix.sep));
      }
    }
  }
  await walk(root);
  return out;
}
