import type { CommitTrailer, CommitAction } from "./types.js";

export type ParsedTrailers = CommitTrailer;

const KNOWN_ACTIONS: ReadonlySet<CommitAction> = new Set<CommitAction>([
  "created",
  "updated",
  "archived",
  "verified",
  "commented",
  "flagged",
  "unflagged",
  "related",
  "unrelated",
  "workspace_upsert",
  "reconcile",
]);

export function parseTrailers(message: string): ParsedTrailers | null {
  const fields: Record<string, string> = {};
  // Normalize to LF so the line iterator works uniformly.
  for (const raw of message.replace(/\r\n?/g, "\n").split("\n")) {
    const m = raw.match(/^(AB-[A-Za-z]+):\s?(.*)$/);
    if (m) fields[m[1]!] = m[2]!.trim();
  }

  const action = fields["AB-Action"] as CommitAction | undefined;
  if (!action || !KNOWN_ACTIONS.has(action)) return null;

  const actor = fields["AB-Actor"] ?? "";
  if (actor === "") return null;
  const reason = fields["AB-Reason"] ? decode(fields["AB-Reason"]) : null;

  if (action === "workspace_upsert") {
    const workspaceId = fields["AB-Workspace"] ?? "";
    if (workspaceId === "") return null;
    return { action, workspaceId, actor, reason };
  }
  if (action === "reconcile") {
    return { action, actor, reason };
  }
  const memoryId = fields["AB-Memory"] ?? "";
  if (memoryId === "") return null;
  return { action, memoryId, actor, reason };
}

function decode(s: string): string {
  // Inverse of trailers.ts `encode`: \\\\ → \\, \\n → LF, \\r → CR.
  // Walk the string once so `\\n` (literal backslash + `n`) round-trips.
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1]!;
      if (next === "\\") {
        out += "\\";
        i++;
        continue;
      }
      if (next === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (next === "r") {
        out += "\r";
        i++;
        continue;
      }
    }
    out += s[i];
  }
  return out;
}
