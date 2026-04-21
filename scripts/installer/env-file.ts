export type EnvLine =
  | { kind: "kv"; key: string; value: string }
  | { kind: "comment"; raw: string }
  | { kind: "blank" };

// Lenient parser: accepts KEY=VALUE lines matching the current .env.example
// shape. No quoting, no multi-line values, no export prefixes. Malformed
// lines abort with the 1-based line number so the user can fix in place.
const KV_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseDotenv(text: string): EnvLine[] {
  const out: EnvLine[] = [];
  const rawLines = text.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim() === "") {
      out.push({ kind: "blank" });
      continue;
    }
    if (line.startsWith("#")) {
      out.push({ kind: "comment", raw: line });
      continue;
    }
    const m = KV_RE.exec(line);
    if (!m) {
      throw new Error(`Malformed .env line ${i + 1}: ${JSON.stringify(line)}`);
    }
    out.push({ kind: "kv", key: m[1], value: m[2] });
  }
  return out;
}
