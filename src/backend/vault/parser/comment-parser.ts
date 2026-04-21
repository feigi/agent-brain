import type { Comment } from "../../../types/memory.js";

const HEADER_RE =
  /^> \[!comment\] (?<author>.+?) · (?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) · (?<id>\S+)$/;

export function parseCommentSection(
  section: string,
  memoryId: string,
): Comment[] {
  if (section.trim() === "") return [];

  const lines = section.split("\n");
  const comments: Comment[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const header = HEADER_RE.exec(line);
    if (!header) {
      throw new Error(`Invalid comment header at line ${i + 1}: ${line}`);
    }

    const { author, ts, id } = header.groups!;
    const bodyLines: string[] = [];
    i++;

    while (i < lines.length) {
      const bodyLine = lines[i]!;
      if (bodyLine === ">") {
        bodyLines.push("");
        i++;
        continue;
      }
      if (bodyLine.startsWith("> ")) {
        bodyLines.push(bodyLine.slice(2));
        i++;
        continue;
      }
      break;
    }

    comments.push({
      id: id!,
      memory_id: memoryId,
      author: author!,
      content: bodyLines.join("\n"),
      created_at: new Date(ts!),
    });
  }

  return comments;
}

export function serializeCommentSection(comments: Comment[]): string {
  if (comments.length === 0) return "";

  const blocks = comments.map((c) => {
    const header = `> [!comment] ${c.author} · ${c.created_at.toISOString()} · ${c.id}`;
    const body = c.content
      .split("\n")
      .map((l) => (l === "" ? ">" : `> ${l}`))
      .join("\n");
    return `${header}\n${body}`;
  });

  return blocks.join("\n\n");
}
