import type { MemorySummaryWithRelevance } from "../types/memory.js";
import type { FlagResponse } from "../types/flag.js";

export interface RenderPreviewResult {
  text: string;
  truncatedCount: number;
}

const DEFAULT_INDEX_BUDGET_BYTES = 1500;

const HEADER = `IMPORTANT — full memories are NOT in this preview.
%LOADED% memories loaded; %SHOWN% shown in index below. Full bodies at:
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
  const shownCount = projectLines.length + keptNonProject.length;
  const loadedCount = shownCount + truncatedCount;
  const text =
    HEADER.replace("%LOADED%", String(loadedCount)).replace(
      "%SHOWN%",
      String(shownCount),
    ) +
    indexBlock +
    FOOTER;
  return { text, truncatedCount };
}

function byteLengthOfLines(lines: string[]): number {
  if (lines.length === 0) return 0;
  return lines.reduce((acc, l) => acc + l.length, 0) + (lines.length - 1);
}

const SECTION_HEADERS = {
  project: "## project rules",
  workspace: "## workspace memories",
  user: "## user memories",
} as const;

function formatDate(d: Date | null | undefined): string {
  if (!d) return "none";
  return d.toISOString().slice(0, 10);
}

function memorySection(m: MemorySummaryWithRelevance): string {
  const tags = m.tags && m.tags.length > 0 ? m.tags.join(", ") : "none";
  const verified = formatDate(m.verified_at);
  return `## ${m.title}

- **id:** ${m.id}
- **scope:** ${m.scope} · **type:** ${m.type} · **author:** ${m.author}
- **created:** ${formatDate(m.created_at)} · **updated:** ${formatDate(m.updated_at)} · **verified:** ${verified}
- **tags:** ${tags}

${m.content}
`;
}

function flagsSection(flags: FlagResponse[]): string {
  const lines = flags.map(
    (f) =>
      `- **${f.flag_id}** (${f.flag_type}) on \`${f.memory.id}\` "${f.memory.title}" — ${f.reason}`,
  );
  return `## flags

${lines.join("\n")}
`;
}

export function renderFull(
  memories: MemorySummaryWithRelevance[],
  flags?: FlagResponse[],
): string {
  const byScope = {
    project: [] as MemorySummaryWithRelevance[],
    workspace: [] as MemorySummaryWithRelevance[],
    user: [] as MemorySummaryWithRelevance[],
  };
  for (const m of memories) {
    byScope[m.scope].push(m);
  }
  for (const k of Object.keys(byScope) as Array<keyof typeof byScope>) {
    byScope[k].sort((a, b) => b.relevance - a.relevance);
  }

  const parts: string[] = [];
  for (const scope of ["project", "workspace", "user"] as const) {
    if (byScope[scope].length === 0) continue;
    parts.push(SECTION_HEADERS[scope]);
    for (const m of byScope[scope]) {
      parts.push(memorySection(m));
    }
  }

  if (flags && flags.length > 0) {
    parts.push(flagsSection(flags));
  }

  return parts.join("\n");
}
