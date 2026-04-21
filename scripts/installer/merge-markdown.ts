import { readFile, writeFile, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";

export interface MergeMarkdownOptions {
  dryRun: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function startMarker(id: string): string {
  return `<!-- ${id}:start -->`;
}
function endMarker(id: string): string {
  return `<!-- ${id}:end -->`;
}

function buildBlock(snippet: string, id: string): string {
  const body = snippet.endsWith("\n") ? snippet : snippet + "\n";
  return `${startMarker(id)}\n${body}${endMarker(id)}\n`;
}

export async function prependWithMarkers(
  file: string,
  snippet: string,
  markerId: string,
  opts: MergeMarkdownOptions,
): Promise<void> {
  const existed = await fileExists(file);
  const existing = existed ? await readFile(file, "utf8") : "";
  const start = startMarker(markerId);
  const end = endMarker(markerId);
  const block = buildBlock(snippet, markerId);

  let next: string;
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);
  if (existed && startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const afterRaw = existing.slice(endIdx + end.length);
    const after = afterRaw.startsWith("\n") ? afterRaw.slice(1) : afterRaw;
    next = before + block + after;
  } else if (existed) {
    const sep = existing.startsWith("\n") || existing === "" ? "" : "\n";
    next = block + sep + existing;
  } else {
    next = block;
  }

  if (opts.dryRun) return;

  if (existed && !(await fileExists(`${file}.bak`))) {
    await copyFile(file, `${file}.bak`);
  }

  await writeFile(file, next, "utf8");
}
