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

export function serialize(lines: EnvLine[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (line.kind === "kv") parts.push(`${line.key}=${line.value}`);
    else if (line.kind === "comment") parts.push(line.raw);
    else parts.push("");
  }
  return parts.join("\n") + "\n";
}

export interface MergeResult {
  lines: EnvLine[];
  added: string[];
  extras: string[];
  changed: boolean;
}

// Walk the template in order so comments and key ordering match .env.example.
// For each kv line, prefer the existing value when the key is already set so
// user customization survives. Keys present only in the existing file are
// appended at the end under a header comment — we never drop user data.
export function mergeEnv(
  existing: EnvLine[],
  template: EnvLine[],
): MergeResult {
  const existingValues = new Map<string, string>();
  for (const line of existing) {
    if (line.kind === "kv") existingValues.set(line.key, line.value);
  }

  const templateKeys = new Set<string>();
  for (const line of template) {
    if (line.kind === "kv") templateKeys.add(line.key);
  }

  const merged: EnvLine[] = [];
  const added: string[] = [];
  for (const line of template) {
    if (line.kind !== "kv") {
      merged.push(line);
      continue;
    }
    const existingVal = existingValues.get(line.key);
    if (existingVal !== undefined) {
      merged.push({ kind: "kv", key: line.key, value: existingVal });
    } else {
      merged.push(line);
      added.push(line.key);
    }
  }

  const extras: string[] = [];
  for (const line of existing) {
    if (line.kind === "kv" && !templateKeys.has(line.key)) {
      extras.push(line.key);
    }
  }

  if (extras.length > 0) {
    merged.push({ kind: "blank" });
    merged.push({ kind: "comment", raw: "# Keys not in .env.example" });
    for (const line of existing) {
      if (line.kind === "kv" && !templateKeys.has(line.key)) {
        merged.push(line);
      }
    }
  }

  const changed = serialize(merged) !== serialize(existing);
  return { lines: merged, added, extras, changed };
}

// Async asker returns the raw user input for a prompt. Injected instead of
// using readline directly so tests can drive prompts without a TTY.
export type Asker = (question: string) => Promise<string>;

export interface FreshAnswers {
  PROJECT_ID: string;
  EMBEDDING_PROVIDER: "titan" | "mock" | "ollama";
}

const VALID_PROVIDERS = ["titan", "mock", "ollama"] as const;

export async function promptFresh(ask: Asker): Promise<FreshAnswers> {
  const projectIdRaw = (await ask("PROJECT_ID (required): ")).trim();
  if (projectIdRaw === "") {
    throw new Error("PROJECT_ID is required and cannot be empty");
  }
  if (projectIdRaw === "my-project") {
    throw new Error(
      "PROJECT_ID 'my-project' is the .env.example placeholder, not a valid value",
    );
  }

  const providerRaw = (
    await ask("EMBEDDING_PROVIDER [titan|mock|ollama] (default ollama): ")
  )
    .trim()
    .toLowerCase();
  const provider = providerRaw === "" ? "ollama" : providerRaw;
  if (!(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `EMBEDDING_PROVIDER must be one of titan|mock|ollama, got '${provider}'`,
    );
  }

  return {
    PROJECT_ID: projectIdRaw,
    EMBEDDING_PROVIDER: provider as FreshAnswers["EMBEDDING_PROVIDER"],
  };
}
