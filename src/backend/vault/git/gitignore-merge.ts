// Returns a gitignore body that includes all `required` rules, preserving
// existing lines and adding only missing ones. Pure + idempotent.
export function mergeGitignore(existing: string, required: string[]): string {
  const existingLines = existing.split(/\r?\n/);
  const present = new Set(existingLines.map((l) => l.trim()).filter(Boolean));
  const missing = required.filter((r) => !present.has(r.trim()));
  if (missing.length === 0) {
    return existing.endsWith("\n") || existing === ""
      ? existing
      : existing + "\n";
  }
  const sep =
    existing === ""
      ? ""
      : (existing.endsWith("\n") ? "" : "\n") + "\n# added by agent-brain\n";
  return existing + sep + missing.join("\n") + "\n";
}
