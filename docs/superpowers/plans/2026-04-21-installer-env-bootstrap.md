# Installer `.env` Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the installer so `npm run install:agent` creates or merges the repo-root `.env` file for the user, prompting only for values without safe defaults and never overwriting existing values.

**Architecture:** Add one new module `scripts/installer/env-file.ts` with pure `parseDotenv` / `mergeEnv` / `serialize` functions plus a `bootstrapEnv` orchestrator that handles prompts and filesystem side effects. Wire the orchestrator into `runInstaller` in `index.ts` after preflight, before target application. Skip when `--uninstall`. Print plan and make no writes when `--dry-run`.

**Tech Stack:** Node.js (NodeNext ESM, `.js` import specifiers), TypeScript strict, Vitest unit tests, existing `fs-util` helpers (`atomicWrite`, `writeBackup`, `fileExists`), `node:readline/promises`.

**Spec:** [`docs/superpowers/specs/2026-04-21-installer-env-bootstrap-design.md`](../specs/2026-04-21-installer-env-bootstrap-design.md)

---

## File Structure

**Create:**

- `scripts/installer/env-file.ts` — all logic: types, parse, serialize, merge, prompt helper, `bootstrapEnv` orchestrator. Single file because the pieces form one cohesive unit and none is reused elsewhere.
- `tests/unit/installer/env-file.test.ts` — unit tests for parse, serialize, merge, and orchestrator (using tmp dirs + injected prompt + injected logger).

**Modify:**

- `scripts/installer/index.ts` — import `bootstrapEnv`, call it inside `runInstaller` after the preflight loop and before the target apply loop, guarded by `!opts.uninstall`.

---

## Task 1: Parser — line model and `parseDotenv`

**Files:**

- Create: `scripts/installer/env-file.ts`
- Test: `tests/unit/installer/env-file.test.ts`

- [ ] **Step 1: Write failing tests for `parseDotenv`**

Create `tests/unit/installer/env-file.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDotenv } from "../../../scripts/installer/env-file.js";

describe("parseDotenv", () => {
  it("parses KEY=VALUE lines", () => {
    const lines = parseDotenv("FOO=bar\nBAZ=qux\n");
    expect(lines).toEqual([
      { kind: "kv", key: "FOO", value: "bar" },
      { kind: "kv", key: "BAZ", value: "qux" },
    ]);
  });

  it("preserves comments verbatim", () => {
    const lines = parseDotenv("# a comment\nFOO=bar\n");
    expect(lines[0]).toEqual({ kind: "comment", raw: "# a comment" });
    expect(lines[1]).toEqual({ kind: "kv", key: "FOO", value: "bar" });
  });

  it("preserves blank lines", () => {
    const lines = parseDotenv("FOO=bar\n\nBAZ=qux\n");
    expect(lines[1]).toEqual({ kind: "blank" });
  });

  it("accepts empty values", () => {
    const lines = parseDotenv("FOO=\n");
    expect(lines).toEqual([{ kind: "kv", key: "FOO", value: "" }]);
  });

  it("accepts values containing '='", () => {
    const lines = parseDotenv("URL=postgresql://a:b@host:5432/db\n");
    expect(lines[0]).toEqual({
      kind: "kv",
      key: "URL",
      value: "postgresql://a:b@host:5432/db",
    });
  });

  it("tolerates missing trailing newline", () => {
    const lines = parseDotenv("FOO=bar");
    expect(lines).toEqual([{ kind: "kv", key: "FOO", value: "bar" }]);
  });

  it("throws with line number for malformed line", () => {
    expect(() => parseDotenv("FOO=bar\nnot a kv line\n")).toThrow(/line 2/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: FAIL, `parseDotenv` is not exported / not defined.

- [ ] **Step 3: Implement `EnvLine` + `parseDotenv` in `scripts/installer/env-file.ts`**

Create `scripts/installer/env-file.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/env-file.ts tests/unit/installer/env-file.test.ts
git commit -m "feat(installer): add parseDotenv for repo .env"
```

---

## Task 2: Serializer + roundtrip

**Files:**

- Modify: `scripts/installer/env-file.ts`
- Test: `tests/unit/installer/env-file.test.ts`

- [ ] **Step 1: Add failing serialize tests**

Append to `tests/unit/installer/env-file.test.ts`:

```ts
import { serialize } from "../../../scripts/installer/env-file.js";

describe("serialize", () => {
  it("emits KEY=VALUE with trailing newline", () => {
    const out = serialize([{ kind: "kv", key: "FOO", value: "bar" }]);
    expect(out).toBe("FOO=bar\n");
  });

  it("preserves comment raw text", () => {
    const out = serialize([
      { kind: "comment", raw: "# hello" },
      { kind: "kv", key: "FOO", value: "bar" },
    ]);
    expect(out).toBe("# hello\nFOO=bar\n");
  });

  it("emits blank lines as empty", () => {
    const out = serialize([
      { kind: "kv", key: "FOO", value: "bar" },
      { kind: "blank" },
      { kind: "kv", key: "BAZ", value: "qux" },
    ]);
    expect(out).toBe("FOO=bar\n\nBAZ=qux\n");
  });

  it("roundtrips canonical .env.example content", () => {
    const input =
      "# Project\nPROJECT_ID=my-project\n\n# DB\nDATABASE_URL=postgresql://a@b/c\n";
    expect(serialize(parseDotenv(input))).toBe(input);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: FAIL, `serialize` not exported.

- [ ] **Step 3: Implement `serialize`**

Append to `scripts/installer/env-file.ts`:

```ts
export function serialize(lines: EnvLine[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (line.kind === "kv") parts.push(`${line.key}=${line.value}`);
    else if (line.kind === "comment") parts.push(line.raw);
    else parts.push("");
  }
  return parts.join("\n") + "\n";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/env-file.ts tests/unit/installer/env-file.test.ts
git commit -m "feat(installer): serialize EnvLine list to dotenv text"
```

---

## Task 3: `mergeEnv` — template-shaped merge preserving existing values

**Files:**

- Modify: `scripts/installer/env-file.ts`
- Test: `tests/unit/installer/env-file.test.ts`

- [ ] **Step 1: Add failing merge tests**

Append to `tests/unit/installer/env-file.test.ts`:

```ts
import { mergeEnv } from "../../../scripts/installer/env-file.js";

describe("mergeEnv", () => {
  const parse = parseDotenv;

  it("fresh (empty existing) emits full template", () => {
    const template = parse("# P\nPROJECT_ID=my-project\nPORT=19898\n");
    const r = mergeEnv([], template);
    expect(serialize(r.lines)).toBe("# P\nPROJECT_ID=my-project\nPORT=19898\n");
    expect(r.added).toEqual(["PROJECT_ID", "PORT"]);
    expect(r.extras).toEqual([]);
    expect(r.changed).toBe(true);
  });

  it("identical existing = no changes", () => {
    const text = "PROJECT_ID=x\nPORT=19898\n";
    const r = mergeEnv(parse(text), parse(text));
    expect(serialize(r.lines)).toBe(text);
    expect(r.added).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it("existing value beats template default for shared key", () => {
    const existing = parse("PROJECT_ID=real-id\nPORT=19898\n");
    const template = parse("PROJECT_ID=my-project\nPORT=19898\n");
    const r = mergeEnv(existing, template);
    expect(serialize(r.lines)).toBe("PROJECT_ID=real-id\nPORT=19898\n");
    expect(r.added).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it("missing key in existing is inserted in template position", () => {
    const existing = parse("PROJECT_ID=x\n");
    const template = parse(
      "# P\nPROJECT_ID=my-project\n# server\nPORT=19898\n",
    );
    const r = mergeEnv(existing, template);
    expect(serialize(r.lines)).toBe(
      "# P\nPROJECT_ID=x\n# server\nPORT=19898\n",
    );
    expect(r.added).toEqual(["PORT"]);
    expect(r.changed).toBe(true);
  });

  it("extras (keys only in existing) are appended under a comment", () => {
    const existing = parse("PROJECT_ID=x\nCUSTOM=keep-me\n");
    const template = parse("PROJECT_ID=my-project\n");
    const r = mergeEnv(existing, template);
    const out = serialize(r.lines);
    expect(out).toContain("# Keys not in .env.example");
    expect(out).toContain("CUSTOM=keep-me");
    expect(r.extras).toEqual(["CUSTOM"]);
    expect(r.changed).toBe(true);
  });

  it("does not add the extras comment when there are no extras", () => {
    const existing = parse("PROJECT_ID=x\n");
    const template = parse("PROJECT_ID=my-project\nPORT=19898\n");
    const r = mergeEnv(existing, template);
    expect(serialize(r.lines)).not.toContain("# Keys not in .env.example");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: FAIL, `mergeEnv` not exported.

- [ ] **Step 3: Implement `mergeEnv`**

Append to `scripts/installer/env-file.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/env-file.ts tests/unit/installer/env-file.test.ts
git commit -m "feat(installer): merge .env preserving existing values"
```

---

## Task 4: Fresh-install prompt helper (injectable)

**Files:**

- Modify: `scripts/installer/env-file.ts`
- Test: `tests/unit/installer/env-file.test.ts`

- [ ] **Step 1: Add failing tests for `promptFresh` with an injected asker**

Append to `tests/unit/installer/env-file.test.ts`:

```ts
import { promptFresh } from "../../../scripts/installer/env-file.js";

describe("promptFresh", () => {
  function asker(answers: Record<string, string>) {
    return async (q: string) => {
      for (const key of Object.keys(answers)) {
        if (q.includes(key)) return answers[key];
      }
      throw new Error(`Unexpected prompt: ${q}`);
    };
  }

  it("collects PROJECT_ID and EMBEDDING_PROVIDER", async () => {
    const got = await promptFresh(
      asker({ PROJECT_ID: "proj-x", EMBEDDING_PROVIDER: "titan" }),
    );
    expect(got).toEqual({
      PROJECT_ID: "proj-x",
      EMBEDDING_PROVIDER: "titan",
    });
  });

  it("defaults EMBEDDING_PROVIDER to ollama on empty input", async () => {
    const got = await promptFresh(
      asker({ PROJECT_ID: "proj-x", EMBEDDING_PROVIDER: "" }),
    );
    expect(got.EMBEDDING_PROVIDER).toBe("ollama");
  });

  it("rejects empty PROJECT_ID", async () => {
    await expect(
      promptFresh(asker({ PROJECT_ID: "", EMBEDDING_PROVIDER: "ollama" })),
    ).rejects.toThrow(/PROJECT_ID/);
  });

  it("rejects placeholder PROJECT_ID 'my-project'", async () => {
    await expect(
      promptFresh(
        asker({
          PROJECT_ID: "my-project",
          EMBEDDING_PROVIDER: "ollama",
        }),
      ),
    ).rejects.toThrow(/placeholder/);
  });

  it("rejects invalid EMBEDDING_PROVIDER", async () => {
    await expect(
      promptFresh(asker({ PROJECT_ID: "proj-x", EMBEDDING_PROVIDER: "gpt4" })),
    ).rejects.toThrow(/titan|mock|ollama/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: FAIL, `promptFresh` not exported.

- [ ] **Step 3: Implement `promptFresh` with an injectable asker**

Append to `scripts/installer/env-file.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/env-file.ts tests/unit/installer/env-file.test.ts
git commit -m "feat(installer): prompt helper for fresh .env bootstrap"
```

---

## Task 5: `bootstrapEnv` orchestrator — fresh path

**Files:**

- Modify: `scripts/installer/env-file.ts`
- Test: `tests/unit/installer/env-file.test.ts`

- [ ] **Step 1: Add failing tests for fresh `bootstrapEnv`**

Append to `tests/unit/installer/env-file.test.ts`:

```ts
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapEnv } from "../../../scripts/installer/env-file.js";

describe("bootstrapEnv (fresh)", () => {
  let dir: string;
  const exampleText =
    "# Project\nPROJECT_ID=my-project\n\n# Embedding\nEMBEDDING_PROVIDER=ollama\nEMBEDDING_DIMENSIONS=768\n";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envboot-"));
    writeFileSync(join(dir, ".env.example"), exampleText);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates .env with answers substituted, no .bak", async () => {
    const logs: string[] = [];
    const plan = await bootstrapEnv(dir, {
      dryRun: false,
      ask: async (q) => {
        if (q.includes("PROJECT_ID")) return "real-proj";
        if (q.includes("EMBEDDING_PROVIDER")) return "titan";
        throw new Error(`unexpected prompt: ${q}`);
      },
      log: (m) => logs.push(m),
    });
    expect(plan.mode).toBe("fresh");
    expect(plan.added).toEqual([
      "PROJECT_ID",
      "EMBEDDING_PROVIDER",
      "EMBEDDING_DIMENSIONS",
    ]);
    const written = readFileSync(join(dir, ".env"), "utf8");
    expect(written).toContain("PROJECT_ID=real-proj");
    expect(written).toContain("EMBEDDING_PROVIDER=titan");
    expect(written).toContain("EMBEDDING_DIMENSIONS=768");
    expect(readdirSync(dir).some((n) => n.startsWith(".env.bak"))).toBe(false);
  });

  it("fresh + dryRun does not write .env", async () => {
    await bootstrapEnv(dir, {
      dryRun: true,
      ask: async () => "real-proj",
      log: () => undefined,
    });
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("throws when .env.example missing", async () => {
    rmSync(join(dir, ".env.example"));
    await expect(
      bootstrapEnv(dir, {
        dryRun: false,
        ask: async () => "x",
        log: () => undefined,
      }),
    ).rejects.toThrow(/\.env\.example/);
  });

  it("throws when repo root is not writable", async () => {
    // Make dir read-only so atomicWrite probe will fail. Keep .env.example
    // readable; we still expect bootstrapEnv to surface a clear write error
    // before prompting.
    const { chmodSync } = await import("node:fs");
    chmodSync(dir, 0o555);
    try {
      await expect(
        bootstrapEnv(dir, {
          dryRun: false,
          ask: async () => "real-proj",
          log: () => undefined,
        }),
      ).rejects.toThrow(/writ/i);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: FAIL, `bootstrapEnv` not exported.

- [ ] **Step 3: Implement `bootstrapEnv` (fresh path only for now)**

Append to `scripts/installer/env-file.ts`:

```ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, fileExists, writeBackup } from "./fs-util.js";

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
    const added = template
      .filter((l): l is Extract<EnvLine, { kind: "kv" }> => l.kind === "kv")
      .map((l) => l.key);

    if (opts.dryRun) {
      opts.log(`dry-run: would create ${envPath} with ${added.length} keys`);
    } else {
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

  throw new Error("merge path not yet implemented");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/env-file.ts tests/unit/installer/env-file.test.ts
git commit -m "feat(installer): bootstrapEnv fresh-install path"
```

---

## Task 6: `bootstrapEnv` — merge + noop paths, placeholder warning

**Files:**

- Modify: `scripts/installer/env-file.ts`
- Test: `tests/unit/installer/env-file.test.ts`

- [ ] **Step 1: Add failing tests for the merge, noop, and warning paths**

Append to `tests/unit/installer/env-file.test.ts`:

```ts
describe("bootstrapEnv (existing)", () => {
  let dir: string;
  const exampleText =
    "PROJECT_ID=my-project\nEMBEDDING_PROVIDER=ollama\nPORT=19898\n";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envboot-"));
    writeFileSync(join(dir, ".env.example"), exampleText);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("noop when .env has every template key", async () => {
    writeFileSync(
      join(dir, ".env"),
      "PROJECT_ID=real\nEMBEDDING_PROVIDER=titan\nPORT=19898\n",
    );
    const logs: string[] = [];
    const plan = await bootstrapEnv(dir, {
      dryRun: false,
      ask: async () => {
        throw new Error("should not prompt on merge path");
      },
      log: (m) => logs.push(m),
    });
    expect(plan.mode).toBe("noop");
    expect(plan.added).toEqual([]);
    expect(plan.willBackup).toBe(false);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      "PROJECT_ID=real\nEMBEDDING_PROVIDER=titan\nPORT=19898\n",
    );
    expect(readdirSync(dir).some((n) => n.startsWith(".env.bak"))).toBe(false);
  });

  it("merges missing key, writes backup", async () => {
    writeFileSync(
      join(dir, ".env"),
      "PROJECT_ID=real\nEMBEDDING_PROVIDER=titan\n",
    );
    const plan = await bootstrapEnv(dir, {
      dryRun: false,
      ask: async () => {
        throw new Error("should not prompt on merge path");
      },
      log: () => undefined,
    });
    expect(plan.mode).toBe("merge");
    expect(plan.added).toEqual(["PORT"]);
    expect(plan.willBackup).toBe(true);
    const merged = readFileSync(join(dir, ".env"), "utf8");
    expect(merged).toContain("PROJECT_ID=real");
    expect(merged).toContain("EMBEDDING_PROVIDER=titan");
    expect(merged).toContain("PORT=19898");
    const baks = readdirSync(dir).filter((n) => n.startsWith(".env.bak."));
    expect(baks).toHaveLength(1);
  });

  it("merge + dryRun does not write or backup", async () => {
    writeFileSync(join(dir, ".env"), "PROJECT_ID=real\n");
    const originalEnv = readFileSync(join(dir, ".env"), "utf8");
    await bootstrapEnv(dir, {
      dryRun: true,
      ask: async () => {
        throw new Error("no prompt expected");
      },
      log: () => undefined,
    });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(originalEnv);
    expect(readdirSync(dir).some((n) => n.startsWith(".env.bak"))).toBe(false);
  });

  it("warns when existing PROJECT_ID is placeholder", async () => {
    writeFileSync(
      join(dir, ".env"),
      "PROJECT_ID=my-project\nEMBEDDING_PROVIDER=titan\nPORT=19898\n",
    );
    const plan = await bootstrapEnv(dir, {
      dryRun: false,
      ask: async () => {
        throw new Error("no prompt");
      },
      log: () => undefined,
    });
    expect(plan.warnings.some((w) => w.includes("PROJECT_ID"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: FAIL, "merge path not yet implemented".

- [ ] **Step 3: Replace the trailing throw in `bootstrapEnv` with the full merge path**

In `scripts/installer/env-file.ts`, replace:

```ts
  throw new Error("merge path not yet implemented");
}
```

with:

```ts
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
  opts.log(
    `OK merged .env (added: ${merged.added.join(", ") || "none"})`,
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/installer/env-file.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/env-file.ts tests/unit/installer/env-file.test.ts
git commit -m "feat(installer): bootstrapEnv merge + noop paths with placeholder warning"
```

---

## Task 7: Wire `bootstrapEnv` into the installer entry point

**Files:**

- Modify: `scripts/installer/index.ts`
- Test: `tests/unit/installer/install.test.ts`

- [ ] **Step 1: Inspect existing `runInstaller` and `install.test.ts`**

Read `scripts/installer/index.ts` and `tests/unit/installer/install.test.ts`. Note the existing `readline` usage and the tmp-dir pattern used for `runInstaller` tests. The goal is to mirror that pattern for the two new tests below.

- [ ] **Step 2: Add failing integration tests to `tests/unit/installer/install.test.ts`**

Follow the existing file's `beforeEach`/`afterEach` style for tmp `repoRoot` and `home`. Add:

```ts
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runInstaller } from "../../../scripts/installer/index.js";

it("runs .env bootstrap on install (dry-run, noop path)", async () => {
  writeFileSync(join(repoRoot, ".env.example"), "PROJECT_ID=x\n");
  writeFileSync(join(repoRoot, ".env"), "PROJECT_ID=x\n");

  await runInstaller(
    { targets: ["claude"], dryRun: true, uninstall: false },
    { repoRoot, home },
  );

  expect(readFileSync(join(repoRoot, ".env"), "utf8")).toBe("PROJECT_ID=x\n");
});

it("skips .env bootstrap on --uninstall (no .env.example required)", async () => {
  await runInstaller(
    { targets: ["claude"], dryRun: true, uninstall: true },
    { repoRoot, home },
  );

  expect(existsSync(join(repoRoot, ".env"))).toBe(false);
});
```

If the existing `install.test.ts` does not already exercise `runInstaller`, instead add a new file `tests/unit/installer/install-env.test.ts` with its own tmp setup following the pattern in `merge-markdown.test.ts`.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/installer/install.test.ts`
Expected: FAIL — either the dry-run noop reports an error because `bootstrapEnv` is never called, or the `--uninstall` case is unaffected (in which case only the first test fails). Either way the first assertion fails because no bootstrap wiring exists yet.

- [ ] **Step 4: Wire `bootstrapEnv` into `runInstaller`**

Edit `scripts/installer/index.ts`. Add alongside existing imports:

```ts
import { bootstrapEnv } from "./env-file.js";
```

(No new `createInterface` import — the file already imports it from `node:readline/promises`.)

Inside `runInstaller`, immediately after the preflight loop and before the target apply loop, add:

```ts
if (!opts.uninstall) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    await bootstrapEnv(env.repoRoot, {
      dryRun: opts.dryRun,
      ask: (q) => rl.question(q),
      log: (m) => console.log(m),
    });
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 5: Run installer test suite**

Run: `npx vitest run tests/unit/installer/`
Expected: all tests pass.

- [ ] **Step 6: Run typecheck + full unit suite**

Run in parallel:

- `npm run typecheck`
- `npm run test:unit`

Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add scripts/installer/index.ts tests/unit/installer/install.test.ts
git commit -m "feat(installer): run .env bootstrap during install"
```

---

## Task 8: Manual end-to-end verification

**Files:**

- None modified

- [ ] **Step 1: Fresh install dry-run in a throwaway repo clone**

```bash
cd "$(mktemp -d)"
git clone /Users/chris/dev/agent-brain repo
cd repo
npm ci
npm run install:agent -- --target=claude --dry-run
```

Expected: output mentions creating `.env` under "dry-run: would create …"; `.env` is NOT written.

- [ ] **Step 2: Real fresh install with scripted answers**

```bash
printf 'my-real-project\nollama\n' | npm run install:agent -- --target=claude
```

Expected: `.env` now exists. `PROJECT_ID=my-real-project`, `EMBEDDING_PROVIDER=ollama`, rest match `.env.example` defaults. No `.env.bak.*` file.

- [ ] **Step 3: Re-run installer (idempotency)**

```bash
npm run install:agent -- --target=claude
```

Expected: noop message, `.env` unchanged, no new `.env.bak.*`.

- [ ] **Step 4: Simulate a missing key, re-run**

Remove a non-critical line from `.env` (e.g. `PORT=19898`), then re-run:

```bash
npm run install:agent -- --target=claude
```

Expected: `.env` gets `PORT=19898` restored at its template position; one new `.env.bak.<stamp>` is written; summary message mentions `added: PORT`.

- [ ] **Step 5: Uninstall leaves `.env` alone**

```bash
npm run install:agent -- --target=claude --uninstall
ls .env .env.bak.* 2>/dev/null
```

Expected: `.env` still present and byte-identical to before; no new `.env.bak.*` from this run.

- [ ] **Step 6: Report findings**

If any step diverges from expected, stop and fix — do not mark this plan complete.

---

## Verification summary (run before declaring done)

- `npm run typecheck` — clean
- `npm run test:unit` — all tests pass including new `tests/unit/installer/env-file.test.ts`
- `npm run lint` — clean
- Task 8 manual sequence completed with expected results
