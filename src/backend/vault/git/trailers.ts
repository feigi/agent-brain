import type { CommitTrailer } from "./types.js";

// Escape LF in free-form fields — parsers split trailers on LF.
// Non-free-form values (ids, actions) are validated upstream so no escape needed.
export function formatTrailers(trailer: CommitTrailer): string {
  const lines: string[] = [`AB-Action: ${trailer.action}`];
  if (trailer.action === "workspace_upsert") {
    lines.push(`AB-Workspace: ${trailer.workspaceId}`);
  } else if (trailer.action !== "reconcile") {
    lines.push(`AB-Memory: ${trailer.memoryId}`);
  }
  lines.push(`AB-Actor: ${trailer.actor}`);
  if (trailer.reason != null && trailer.reason !== "") {
    lines.push(`AB-Reason: ${encode(trailer.reason)}`);
  }
  return lines.join("\n");
}

function encode(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}
