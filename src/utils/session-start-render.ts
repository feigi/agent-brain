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
  _indexBudget: number = DEFAULT_INDEX_BUDGET_BYTES, // eslint-disable-line @typescript-eslint/no-unused-vars
): RenderPreviewResult {
  const rows = memories.map(indexRow);
  const indexBlock = rows.join("\n");
  const text =
    HEADER.replace("%COUNT%", String(memories.length)) + indexBlock + FOOTER;
  return { text, truncatedCount: 0 };
}

export function renderFull(
  _memories: MemorySummaryWithRelevance[], // eslint-disable-line @typescript-eslint/no-unused-vars
  _flags?: FlagResponse[], // eslint-disable-line @typescript-eslint/no-unused-vars
): string {
  return "";
}
