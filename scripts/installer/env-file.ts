import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, fileExists, writeBackup } from "./fs-util.js";

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

// Confirm the repo root is writable before we prompt the user for input —
// otherwise we would block on readline and then fail at write time.
// Mirrors the probe pattern in preflight.ts:47.
async function assertWritable(dir: string): Promise<void> {
  const probeDir = join(dir, ".agent-brain-probe");
  try {
    await mkdir(probeDir, { recursive: true });
    const probe = join(probeDir, "probe");
    await writeFile(probe, "", "utf8");
  } catch (e) {
    throw new Error(
      `Repo root ${dir} is not writable: ${(e as Error).message}`,
      { cause: e },
    );
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

export interface BootstrapOptions {
  dryRun: boolean;
  ask: Asker;
  log: (msg: string) => void;
}

export interface BootstrapPlan {
  mode: "fresh" | "merge" | "noop";
  added: string[];
  extras: string[];
  willBackup: boolean;
  warnings: string[];
}

export async function bootstrapEnv(
  repoRoot: string,
  opts: BootstrapOptions,
): Promise<BootstrapPlan> {
  const examplePath = join(repoRoot, ".env.example");
  const envPath = join(repoRoot, ".env");

  if (!(await fileExists(examplePath))) {
    throw new Error(
      `.env.example not found at ${examplePath} — cannot bootstrap .env`,
    );
  }
  await assertWritable(repoRoot);
  const templateText = await readFile(examplePath, "utf8");
  const template = parseDotenv(templateText);

  const envExists = await fileExists(envPath);

  if (!envExists) {
    const added = template
      .filter((l): l is Extract<EnvLine, { kind: "kv" }> => l.kind === "kv")
      .map((l) => l.key);

    if (opts.dryRun) {
      opts.log(`dry-run: would create ${envPath} with ${added.length} keys`);
    } else {
      const answers = await promptFresh(opts.ask);
      const withAnswers: EnvLine[] = template.map((line) => {
        if (line.kind !== "kv") return line;
        if (line.key === "PROJECT_ID")
          return { kind: "kv", key: line.key, value: answers.PROJECT_ID };
        if (line.key === "EMBEDDING_PROVIDER")
          return {
            kind: "kv",
            key: line.key,
            value: answers.EMBEDDING_PROVIDER,
          };
        return line;
      });
      await atomicWrite(envPath, serialize(withAnswers));
      opts.log(`OK wrote ${envPath} (${added.length} keys)`);
    }

    return {
      mode: "fresh",
      added,
      extras: [],
      willBackup: false,
      warnings: [],
    };
  }

  const existingText = await readFile(envPath, "utf8");
  const existing = parseDotenv(existingText);
  const merged = mergeEnv(existing, template);

  const warnings: string[] = [];
  const projectIdLine = existing.find(
    (l): l is Extract<EnvLine, { kind: "kv" }> =>
      l.kind === "kv" && l.key === "PROJECT_ID",
  );
  if (projectIdLine && projectIdLine.value === "my-project") {
    warnings.push(
      "warn: PROJECT_ID is still the placeholder 'my-project' in .env — set a real project id before starting the server",
    );
  }

  if (!merged.changed) {
    opts.log("OK .env up to date with .env.example");
    for (const w of warnings) opts.log(w);
    return {
      mode: "noop",
      added: merged.added,
      extras: merged.extras,
      willBackup: false,
      warnings,
    };
  }

  const nextText = serialize(merged.lines);
  if (opts.dryRun) {
    opts.log(
      `dry-run: would merge .env (add: ${merged.added.join(", ") || "none"}; extras preserved: ${merged.extras.join(", ") || "none"})`,
    );
    for (const w of warnings) opts.log(w);
    return {
      mode: "merge",
      added: merged.added,
      extras: merged.extras,
      willBackup: true,
      warnings,
    };
  }

  await writeBackup(envPath);
  await atomicWrite(envPath, nextText);
  opts.log(`OK merged .env (added: ${merged.added.join(", ") || "none"})`);
  for (const w of warnings) opts.log(w);

  return {
    mode: "merge",
    added: merged.added,
    extras: merged.extras,
    willBackup: true,
    warnings,
  };
}
