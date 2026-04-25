import type { MemorySummaryWithRelevance } from "../types/memory.js";
import type { FlagResponse } from "../types/flag.js";

export interface RenderPreviewResult {
  text: string;
  truncatedCount: number;
}

const DEFAULT_INDEX_BUDGET_BYTES = 1500;

const HEADER = `IMPORTANT — full memories are NOT in this preview.
Index below shows %COUNT% memories. Full bodies at:
{{PATH}}

You MUST Read this file before responding to the user's
first message. Do not proceed without it.

## Memory index
`;

const FOOTER = `
Search guidance: see your memory instructions
(CLAUDE.md / agent-brain snippet).
`;

function indexRow(m: MemorySummaryWithRelevance): string {
  return `- ${m.id} [${m.scope}] ${m.type} — ${m.title}`;
}

export function renderPreview(
  memories: MemorySummaryWithRelevance[],
  indexBudget: number = DEFAULT_INDEX_BUDGET_BYTES,
): RenderPreviewResult {
  const projectRows = memories.filter((m) => m.scope === "project");
  const nonProjectRows = memories
    .filter((m) => m.scope !== "project")
    .slice()
    .sort((a, b) => b.relevance - a.relevance);

  const projectLines = projectRows.map(indexRow);
  const projectBytes = byteLengthOfLines(projectLines);

  let remaining = indexBudget - projectBytes;
  const keptNonProject: string[] = [];
  let truncatedCount = 0;
  for (const m of nonProjectRows) {
    const line = indexRow(m);
    const cost =
      keptNonProject.length === 0 && projectLines.length === 0
        ? line.length
        : line.length + 1; // +1 for joining newline
    if (cost <= remaining) {
      keptNonProject.push(line);
      remaining -= cost;
    } else {
      truncatedCount++;
    }
  }

  const indexBlock = [...projectLines, ...keptNonProject].join("\n");
  const totalCount =
    projectRows.length + keptNonProject.length + truncatedCount;
  const text =
    HEADER.replace("%COUNT%", String(totalCount)) + indexBlock + FOOTER;
  return { text, truncatedCount };
}

function byteLengthOfLines(lines: string[]): number {
  if (lines.length === 0) return 0;
  return lines.reduce((acc, l) => acc + l.length, 0) + (lines.length - 1);
}

export function renderFull(
  _memories: MemorySummaryWithRelevance[], // eslint-disable-line @typescript-eslint/no-unused-vars
  _flags?: FlagResponse[], // eslint-disable-line @typescript-eslint/no-unused-vars
): string {
  return "";
}
