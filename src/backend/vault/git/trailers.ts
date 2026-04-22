import type { CommitTrailer } from "./types.js";

// Maps a CommitTrailer into git-interpret-trailers-compatible lines.
// Newlines inside free-form fields (reason) are escaped as `\\n` so
// the trailer block stays a single logical paragraph — git log parsers
// in Phase 4c split on LF and rely on that.
export function formatTrailers(trailer: CommitTrailer): string {
  const lines: string[] = [`AB-Action: ${trailer.action}`];
  if (trailer.action === "workspace_upsert") {
    if (!trailer.workspaceId) {
      throw new Error("workspaceId required for workspace_upsert");
    }
    lines.push(`AB-Workspace: ${trailer.workspaceId}`);
  } else {
    if (!trailer.memoryId) {
      throw new Error(`memoryId required for action ${trailer.action}`);
    }
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
