import { readFile } from "node:fs/promises";
import type { MarkerId } from "./types.js";
import { atomicWrite, fileExists, writeBackup } from "./fs-util.js";

export interface MergeMarkdownOptions {
  dryRun: boolean;
}

function startMarker(id: MarkerId): string {
  return `<!-- ${id}:start -->`;
}
function endMarker(id: MarkerId): string {
  return `<!-- ${id}:end -->`;
}

function buildBlock(snippet: string, id: MarkerId): string {
  const body = snippet.endsWith("\n") ? snippet : snippet + "\n";
  return `${startMarker(id)}\n${body}${endMarker(id)}\n`;
}

export async function prependWithMarkers(
  file: string,
  snippet: string,
  markerId: MarkerId,
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
    const sep = existing.startsWith("\n") ? "" : "\n";
    next = block + sep + existing;
  } else {
    next = block;
  }

  if (opts.dryRun) return;

  if (existed) {
    const bak = await writeBackup(file);
    console.log(`Backup: ${bak}`);
  }

  await atomicWrite(file, next);
}
