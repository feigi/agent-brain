# Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a scripted installer (`npm run install:agent`) that wires Agent Brain into a user-level Claude Code or GitHub Copilot CLI setup — copying hook scripts, merging JSON config, prepending agent instructions with markers, and printing the docker-compose command.

**Architecture:** Modular `scripts/installer/` tree. Pure `plan()` per target describes actions; shared `mergeJson` / `prependWithMarkers` helpers execute them. Strict preflight, `.bak` backups, idempotent re-run, symmetric `--uninstall`.

**Tech Stack:** Node 22, TypeScript, `tsx` (already repo-standard), `node:util.parseArgs`, vitest for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-21-installer-design.md`

---

## File Structure

| File                                          | Responsibility                                               |
| --------------------------------------------- | ------------------------------------------------------------ |
| `scripts/installer/types.ts`                  | `Target`, `InstallPlan`, `Options` interfaces                |
| `scripts/installer/merge-json.ts`             | Deep-merge JSON patch into file, `.bak` on first run         |
| `scripts/installer/merge-markdown.ts`         | Marker-based prepend/replace in markdown file                |
| `scripts/installer/preflight.ts`              | `jq` check, target-dir writable check, docker warn           |
| `scripts/installer/targets/claude.ts`         | Claude plan + paths                                          |
| `scripts/installer/targets/copilot.ts`        | Copilot plan + paths                                         |
| `scripts/installer/apply.ts`                  | Execute an `InstallPlan`: copies + merges + prepends         |
| `scripts/installer/uninstall.ts`              | Reverse a target: delete copies, unmerge JSON, strip markers |
| `scripts/installer/index.ts`                  | CLI entry: flag parse, prompt, dispatch install-or-uninstall |
| `tests/unit/installer/merge-json.test.ts`     | Unit tests for mergeJson                                     |
| `tests/unit/installer/merge-markdown.test.ts` | Unit tests for prependWithMarkers                            |
| `tests/unit/installer/preflight.test.ts`      | Unit tests for preflight (PATH stubbing)                     |
| `tests/unit/installer/targets.test.ts`        | plan() shape checks for both targets                         |
| `tests/unit/installer/install.test.ts`        | End-to-end install into tmp HOME                             |
| `tests/unit/installer/uninstall.test.ts`      | End-to-end uninstall + idempotency                           |

Tests live under `tests/unit/` (no DB needed; use tmp dir sandbox via `HOME` override). Runs with `npm run test:unit`.

---

## Task 1: Scaffold types + tsconfig

**Files:**

- Create: `scripts/installer/types.ts`
- Modify: `tsconfig.json` (add `scripts/**/*` to `include`)

- [ ] **Step 1: Update `tsconfig.json` include**

Change the `include` array to add `"scripts/**/*"`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": [
    "src/**/*",
    "tests/**/*",
    "scripts/**/*",
    "drizzle.config.ts",
    "vitest.config.ts",
    "vitest.ci.config.ts",
    "eslint.config.mjs"
  ],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Write `scripts/installer/types.ts`**

```ts
export type TargetName = "claude" | "copilot";

export interface CopyAction {
  src: string;
  dest: string;
  mode?: number;
}

export interface JsonMergeAction {
  file: string;
  patch: unknown;
}

export interface MarkdownPrependAction {
  file: string;
  snippet: string;
  markerId: string;
}

export interface InstallPlan {
  target: TargetName;
  copies: CopyAction[];
  jsonMerges: JsonMergeAction[];
  markdownPrepends: MarkdownPrependAction[];
  postInstructions: string[];
}

export interface Target {
  name: TargetName;
  preflight(): Promise<void>;
  plan(repoRoot: string, home: string): InstallPlan;
  describe(plan: InstallPlan): string;
}

export interface RunOptions {
  dryRun: boolean;
  yes: boolean;
  uninstall: boolean;
  targets: TargetName[];
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/installer/types.ts tsconfig.json
git commit -m "feat(installer): scaffold types + extend tsconfig include"
```

---

## Task 2: `mergeJson` helper (TDD)

**Files:**

- Create: `scripts/installer/merge-json.ts`
- Test: `tests/unit/installer/merge-json.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// tests/unit/installer/merge-json.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeJson } from "../../../scripts/installer/merge-json.ts";

describe("mergeJson", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mergejson-"));
    file = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates file from {} when missing", async () => {
    await mergeJson(
      file,
      { mcpServers: { "agent-brain": { url: "u" } } },
      { dryRun: false },
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpServers: { "agent-brain": { url: "u" } },
    });
  });

  it("preserves foreign keys in existing file", async () => {
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { other: { url: "x" } }, theme: "dark" }),
    );
    await mergeJson(
      file,
      { mcpServers: { "agent-brain": { url: "u" } } },
      { dryRun: false },
    );
    const result = JSON.parse(readFileSync(file, "utf8"));
    expect(result).toEqual({
      mcpServers: { other: { url: "x" }, "agent-brain": { url: "u" } },
      theme: "dark",
    });
  });

  it("is idempotent on re-run (array dedupe by JSON.stringify)", async () => {
    const patch = {
      hooks: { SessionStart: [{ type: "command", command: "x" }] },
    };
    await mergeJson(file, patch, { dryRun: false });
    await mergeJson(file, patch, { dryRun: false });
    const result = JSON.parse(readFileSync(file, "utf8"));
    expect(result.hooks.SessionStart).toHaveLength(1);
  });

  it("writes .bak on first run only, never overwrites existing .bak", async () => {
    writeFileSync(file, JSON.stringify({ original: true }));
    await mergeJson(file, { added: 1 }, { dryRun: false });
    expect(existsSync(`${file}.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8"))).toEqual({
      original: true,
    });

    await mergeJson(file, { added: 2 }, { dryRun: false });
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8"))).toEqual({
      original: true,
    });
  });

  it("throws on invalid JSON", async () => {
    writeFileSync(file, "{ not valid json");
    await expect(mergeJson(file, { x: 1 }, { dryRun: false })).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it("dryRun does not write", async () => {
    writeFileSync(file, JSON.stringify({ a: 1 }));
    await mergeJson(file, { b: 2 }, { dryRun: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1 });
    expect(existsSync(`${file}.bak`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/installer/merge-json.test.ts`
Expected: fail — `merge-json.ts` doesn't exist yet.

- [ ] **Step 3: Implement `merge-json.ts`**

```ts
// scripts/installer/merge-json.ts
import { readFile, writeFile, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";

export interface MergeJsonOptions {
  dryRun: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dedupeArray(arr: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of arr) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(patch)) {
    return dedupeArray([...base, ...patch]);
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const result: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      result[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return result;
  }
  return patch;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function mergeJson(
  file: string,
  patch: unknown,
  opts: MergeJsonOptions,
): Promise<void> {
  const existed = await fileExists(file);
  let base: unknown = {};
  if (existed) {
    const raw = await readFile(file, "utf8");
    try {
      base = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${file}: invalid JSON (${msg}). Fix or delete before re-running.`,
      );
    }
  }

  const merged = deepMerge(base, patch);

  if (opts.dryRun) return;

  if (existed && !(await fileExists(`${file}.bak`))) {
    await copyFile(file, `${file}.bak`);
  }

  await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/installer/merge-json.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/merge-json.ts tests/unit/installer/merge-json.test.ts
git commit -m "feat(installer): mergeJson deep-merge with array dedupe + .bak"
```

---

## Task 3: `prependWithMarkers` helper (TDD)

**Files:**

- Create: `scripts/installer/merge-markdown.ts`
- Test: `tests/unit/installer/merge-markdown.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// tests/unit/installer/merge-markdown.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prependWithMarkers } from "../../../scripts/installer/merge-markdown.ts";

describe("prependWithMarkers", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mergemd-"));
    file = join(dir, "CLAUDE.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates file with wrapped snippet when missing", async () => {
    await prependWithMarkers(file, "hello\n", "agent-brain", { dryRun: false });
    const content = readFileSync(file, "utf8");
    expect(content).toContain("<!-- agent-brain:start -->");
    expect(content).toContain("hello");
    expect(content).toContain("<!-- agent-brain:end -->");
  });

  it("prepends wrapped snippet when file exists without markers", async () => {
    writeFileSync(file, "# Existing\nuser content\n");
    await prependWithMarkers(file, "snippet body\n", "agent-brain", {
      dryRun: false,
    });
    const content = readFileSync(file, "utf8");
    expect(content.indexOf("<!-- agent-brain:start -->")).toBe(0);
    expect(content).toContain("snippet body");
    expect(content).toContain("# Existing");
    expect(content.indexOf("# Existing")).toBeGreaterThan(
      content.indexOf("<!-- agent-brain:end -->"),
    );
  });

  it("replaces content between markers on re-run", async () => {
    await prependWithMarkers(file, "v1\n", "agent-brain", { dryRun: false });
    await prependWithMarkers(file, "v2 updated\n", "agent-brain", {
      dryRun: false,
    });
    const content = readFileSync(file, "utf8");
    expect(content).toContain("v2 updated");
    expect(content).not.toContain("v1\n");
    const starts = content.match(/<!-- agent-brain:start -->/g) ?? [];
    expect(starts).toHaveLength(1);
  });

  it("preserves content outside markers when replacing", async () => {
    await prependWithMarkers(file, "v1\n", "agent-brain", { dryRun: false });
    writeFileSync(
      file,
      readFileSync(file, "utf8") + "\n# User section\nuser body\n",
    );
    await prependWithMarkers(file, "v2\n", "agent-brain", { dryRun: false });
    const content = readFileSync(file, "utf8");
    expect(content).toContain("v2");
    expect(content).toContain("# User section");
    expect(content).toContain("user body");
  });

  it("writes .bak on first run only", async () => {
    writeFileSync(file, "original\n");
    await prependWithMarkers(file, "a\n", "agent-brain", { dryRun: false });
    expect(existsSync(`${file}.bak`)).toBe(true);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe("original\n");

    await prependWithMarkers(file, "b\n", "agent-brain", { dryRun: false });
    expect(readFileSync(`${file}.bak`, "utf8")).toBe("original\n");
  });

  it("dryRun does not write", async () => {
    writeFileSync(file, "orig\n");
    await prependWithMarkers(file, "x\n", "agent-brain", { dryRun: true });
    expect(readFileSync(file, "utf8")).toBe("orig\n");
    expect(existsSync(`${file}.bak`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/installer/merge-markdown.test.ts`
Expected: fail — module missing.

- [ ] **Step 3: Implement `merge-markdown.ts`**

```ts
// scripts/installer/merge-markdown.ts
import { readFile, writeFile, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";

export interface MergeMarkdownOptions {
  dryRun: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function startMarker(id: string): string {
  return `<!-- ${id}:start -->`;
}
function endMarker(id: string): string {
  return `<!-- ${id}:end -->`;
}

function buildBlock(snippet: string, id: string): string {
  const body = snippet.endsWith("\n") ? snippet : snippet + "\n";
  return `${startMarker(id)}\n${body}${endMarker(id)}\n`;
}

export async function prependWithMarkers(
  file: string,
  snippet: string,
  markerId: string,
  opts: MergeMarkdownOptions,
): Promise<void> {
  const existed = await fileExists(file);
  const existing = existed ? await readFile(file, "utf8") : "";
  const start = startMarker(markerId);
  const end = endMarker(markerId);
  const block = buildBlock(snippet, markerId);

  let next: string;
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);
  if (existed && startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const afterRaw = existing.slice(endIdx + end.length);
    const after = afterRaw.startsWith("\n") ? afterRaw.slice(1) : afterRaw;
    next = before + block + after;
  } else if (existed) {
    const sep = existing.startsWith("\n") || existing === "" ? "" : "\n";
    next = block + sep + existing;
  } else {
    next = block;
  }

  if (opts.dryRun) return;

  if (existed && !(await fileExists(`${file}.bak`))) {
    await copyFile(file, `${file}.bak`);
  }

  await writeFile(file, next, "utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/installer/merge-markdown.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/merge-markdown.ts tests/unit/installer/merge-markdown.test.ts
git commit -m "feat(installer): prependWithMarkers idempotent marker-based snippet"
```

---

## Task 4: `preflight` helper (TDD)

**Files:**

- Create: `scripts/installer/preflight.ts`
- Test: `tests/unit/installer/preflight.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// tests/unit/installer/preflight.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkJq,
  checkTargetDirWritable,
  checkDockerWarn,
} from "../../../scripts/installer/preflight.ts";

describe("preflight", () => {
  describe("checkJq", () => {
    const originalPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it("passes when jq on PATH", async () => {
      // assume test env has jq; if not, skip via stub below
      const stubDir = mkdtempSync(join(tmpdir(), "pfjq-"));
      const jqPath = join(stubDir, "jq");
      writeFileSync(jqPath, "#!/bin/sh\necho stub\n");
      chmodSync(jqPath, 0o755);
      process.env.PATH = stubDir;
      await expect(checkJq()).resolves.toBeUndefined();
      rmSync(stubDir, { recursive: true, force: true });
    });

    it("throws when jq missing", async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "pfnojq-"));
      process.env.PATH = emptyDir;
      await expect(checkJq()).rejects.toThrow(/jq not found/);
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe("checkTargetDirWritable", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "pfdir-"));
    });
    afterEach(() => {
      try {
        chmodSync(dir, 0o755);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    });

    it("passes when dir exists and writable", async () => {
      await expect(checkTargetDirWritable(dir)).resolves.toBeUndefined();
    });

    it("passes when dir missing but parent writable (creates it)", async () => {
      const child = join(dir, "sub");
      await expect(checkTargetDirWritable(child)).resolves.toBeUndefined();
    });

    it("throws when dir not writable", async () => {
      chmodSync(dir, 0o500);
      const child = join(dir, "blocked");
      await expect(checkTargetDirWritable(child)).rejects.toThrow(
        /not writable/,
      );
    });
  });

  describe("checkDockerWarn", () => {
    const originalPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it("returns null when docker present", async () => {
      const stubDir = mkdtempSync(join(tmpdir(), "pfdocker-"));
      const dockerPath = join(stubDir, "docker");
      writeFileSync(dockerPath, "#!/bin/sh\n");
      chmodSync(dockerPath, 0o755);
      process.env.PATH = stubDir;
      expect(await checkDockerWarn()).toBeNull();
      rmSync(stubDir, { recursive: true, force: true });
    });

    it("returns warning string when docker missing", async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "pfnodocker-"));
      process.env.PATH = emptyDir;
      const result = await checkDockerWarn();
      expect(result).toMatch(/docker not found/);
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/installer/preflight.test.ts`
Expected: module missing.

- [ ] **Step 3: Implement `preflight.ts`**

```ts
// scripts/installer/preflight.ts
import { access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";

const execFile = promisify(execFileCb);

async function onPath(binary: string): Promise<boolean> {
  try {
    await execFile("sh", ["-c", `command -v ${binary}`]);
    return true;
  } catch {
    return false;
  }
}

export async function checkJq(): Promise<void> {
  if (await onPath("jq")) return;
  throw new Error(
    "jq not found. Install: brew install jq (macOS) or apt install jq (Linux).",
  );
}

export async function checkTargetDirWritable(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${dir} not writable: ${msg}`);
  }
  // Probe by creating and removing a temp file
  const probe = join(dir, `.agent-brain-probe-${process.pid}`);
  try {
    await (await import("node:fs/promises")).writeFile(probe, "", "utf8");
    await rm(probe, { force: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${dir} not writable: ${msg}`);
  }
}

export async function checkDockerWarn(): Promise<string | null> {
  if (await onPath("docker")) return null;
  return "docker not found on PATH. You'll need it to run the server (see post-install instructions).";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/installer/preflight.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/preflight.ts tests/unit/installer/preflight.test.ts
git commit -m "feat(installer): strict preflight (jq, target dir, docker warn)"
```

---

## Task 5: Claude target module

**Files:**

- Create: `scripts/installer/targets/claude.ts`
- Test: `tests/unit/installer/targets.test.ts` (shared with Task 6)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/installer/targets.test.ts
import { describe, it, expect } from "vitest";
import { claudeTarget } from "../../../scripts/installer/targets/claude.ts";

describe("claudeTarget.plan", () => {
  const repoRoot = "/repo";
  const home = "/home/u";

  it("has expected copies", () => {
    const plan = claudeTarget.plan(repoRoot, home);
    expect(plan.target).toBe("claude");
    const filenames = plan.copies.map((c) => c.dest.split("/").pop()).sort();
    expect(filenames).toEqual([
      "memory-autofill.sh",
      "memory-guard.sh",
      "memory-nudge.sh",
      "memory-session-review.sh",
      "memory-session-start.sh",
    ]);
    for (const c of plan.copies) {
      expect(c.src.startsWith(`${repoRoot}/hooks/claude/`)).toBe(true);
      expect(c.dest.startsWith(`${home}/.claude/hooks/`)).toBe(true);
      expect(c.mode).toBe(0o755);
    }
  });

  it("has one jsonMerge for settings.json", () => {
    const plan = claudeTarget.plan(repoRoot, home);
    expect(plan.jsonMerges).toHaveLength(1);
    expect(plan.jsonMerges[0].file).toBe("/home/u/.claude/settings.json");
    expect(plan.jsonMerges[0].patch).toBeTypeOf("object");
  });

  it("has one markdownPrepend for CLAUDE.md with agent-brain marker", () => {
    const plan = claudeTarget.plan(repoRoot, home);
    expect(plan.markdownPrepends).toHaveLength(1);
    expect(plan.markdownPrepends[0].file).toBe("/home/u/.claude/CLAUDE.md");
    expect(plan.markdownPrepends[0].markerId).toBe("agent-brain");
    expect(plan.markdownPrepends[0].snippet.length).toBeGreaterThan(100);
  });

  it("postInstructions include docker-compose command", () => {
    const plan = claudeTarget.plan(repoRoot, home);
    expect(
      plan.postInstructions.some((s) => s.includes("docker compose")),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/installer/targets.test.ts`
Expected: fail — module missing.

- [ ] **Step 3: Implement `targets/claude.ts`**

```ts
// scripts/installer/targets/claude.ts
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Target, InstallPlan } from "../types.ts";
import {
  checkJq,
  checkTargetDirWritable,
  checkDockerWarn,
} from "../preflight.ts";

const HOOK_SCRIPTS = [
  "memory-session-start.sh",
  "memory-guard.sh",
  "memory-autofill.sh",
  "memory-nudge.sh",
  "memory-session-review.sh",
];

export const claudeTarget: Target = {
  name: "claude",

  async preflight() {
    await checkJq();
    const warn = await checkDockerWarn();
    if (warn) console.warn(`WARN: ${warn}`);
    await checkTargetDirWritable(`${process.env.HOME ?? ""}/.claude`);
    await checkTargetDirWritable(`${process.env.HOME ?? ""}/.claude/hooks`);
  },

  plan(repoRoot: string, home: string): InstallPlan {
    const hooksDir = join(home, ".claude", "hooks");
    const copies = HOOK_SCRIPTS.map((name) => ({
      src: join(repoRoot, "hooks", "claude", name),
      dest: join(hooksDir, name),
      mode: 0o755,
    }));

    // Snippets are read lazily in apply() via planSnippet(); here we describe references.
    // For consistency the plan carries absolute paths; apply() reads files at write time.
    const snippetPath = join(
      repoRoot,
      "hooks",
      "claude",
      "settings-snippet.json",
    );
    const mdSnippetPath = join(
      repoRoot,
      "hooks",
      "claude",
      "claude-md-snippet.md",
    );

    return {
      target: "claude",
      copies,
      jsonMerges: [
        {
          file: join(home, ".claude", "settings.json"),
          patch: { __fromFile: snippetPath },
        },
      ],
      markdownPrepends: [
        {
          file: join(home, ".claude", "CLAUDE.md"),
          snippet: `__fromFile:${mdSnippetPath}`,
          markerId: "agent-brain",
        },
      ],
      postInstructions: [
        "Start the Agent Brain server:",
        "  docker compose -f docker-compose.prod.yml up -d --wait",
        "Override the MCP URL if needed: export AGENT_BRAIN_URL=http://host:port",
      ],
    };
  },

  describe(plan: InstallPlan): string {
    const lines: string[] = [`Target: ${plan.target}`];
    for (const c of plan.copies) lines.push(`  copy  ${c.src} → ${c.dest}`);
    for (const m of plan.jsonMerges) lines.push(`  merge ${m.file}`);
    for (const p of plan.markdownPrepends)
      lines.push(`  prepend ${p.file} [${p.markerId}]`);
    return lines.join("\n");
  },
};

export async function loadSnippetJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

export async function loadSnippetText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
```

**Note on lazy snippet loading:** `plan()` is pure — so it stores file references (`__fromFile:…`). `apply.ts` (Task 7) resolves them at execution time. This keeps `plan()` synchronous and easy to describe without touching the filesystem.

- [ ] **Step 4: Adjust the failing test assertion about snippet length**

The test checks `snippet.length > 100` on the stored value. Since we now store `__fromFile:/path` (length well over 100 due to absolute paths in tests), keep the assertion. If it fails, shorten it:

Update the test assertion to `expect(plan.markdownPrepends[0].snippet).toMatch(/^__fromFile:/);`.

Rewrite the test block:

```ts
it("has one markdownPrepend for CLAUDE.md with agent-brain marker", () => {
  const plan = claudeTarget.plan(repoRoot, home);
  expect(plan.markdownPrepends).toHaveLength(1);
  expect(plan.markdownPrepends[0].file).toBe("/home/u/.claude/CLAUDE.md");
  expect(plan.markdownPrepends[0].markerId).toBe("agent-brain");
  expect(plan.markdownPrepends[0].snippet).toMatch(/^__fromFile:/);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/installer/targets.test.ts`
Expected: all claude tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/installer/targets/claude.ts tests/unit/installer/targets.test.ts
git commit -m "feat(installer): claude target plan + snippet-file references"
```

---

## Task 6: Copilot target module

**Files:**

- Create: `scripts/installer/targets/copilot.ts`
- Modify: `tests/unit/installer/targets.test.ts` (add copilot block)

- [ ] **Step 1: Add failing test block**

Append to `tests/unit/installer/targets.test.ts`:

```ts
import { copilotTarget } from "../../../scripts/installer/targets/copilot.ts";

describe("copilotTarget.plan", () => {
  const repoRoot = "/repo";
  const home = "/home/u";

  it("copies 3 hook scripts", () => {
    const plan = copilotTarget.plan(repoRoot, home);
    const filenames = plan.copies.map((c) => c.dest.split("/").pop()).sort();
    expect(filenames).toEqual([
      "memory-pretool.sh",
      "memory-session-end.sh",
      "memory-session-start.sh",
    ]);
    for (const c of plan.copies) {
      expect(c.dest.startsWith("/home/u/.copilot/hooks/")).toBe(true);
      expect(c.mode).toBe(0o755);
    }
  });

  it("merges two JSON files: mcp-config.json and hooks/hooks.json", () => {
    const plan = copilotTarget.plan(repoRoot, home);
    const files = plan.jsonMerges.map((m) => m.file).sort();
    expect(files).toEqual([
      "/home/u/.copilot/hooks/hooks.json",
      "/home/u/.copilot/mcp-config.json",
    ]);
  });

  it("prepends copilot-instructions.md with agent-brain marker", () => {
    const plan = copilotTarget.plan(repoRoot, home);
    expect(plan.markdownPrepends).toHaveLength(1);
    expect(plan.markdownPrepends[0].file).toBe(
      "/home/u/.copilot/copilot-instructions.md",
    );
    expect(plan.markdownPrepends[0].markerId).toBe("agent-brain");
  });

  it("postInstructions include docker-compose command", () => {
    const plan = copilotTarget.plan(repoRoot, home);
    expect(
      plan.postInstructions.some((s) => s.includes("docker compose")),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/installer/targets.test.ts`
Expected: copilot tests fail — module missing.

- [ ] **Step 3: Implement `targets/copilot.ts`**

```ts
// scripts/installer/targets/copilot.ts
import { join } from "node:path";
import type { Target, InstallPlan } from "../types.ts";
import {
  checkJq,
  checkTargetDirWritable,
  checkDockerWarn,
} from "../preflight.ts";

const HOOK_SCRIPTS = [
  "memory-session-start.sh",
  "memory-pretool.sh",
  "memory-session-end.sh",
];

export const copilotTarget: Target = {
  name: "copilot",

  async preflight() {
    await checkJq();
    const warn = await checkDockerWarn();
    if (warn) console.warn(`WARN: ${warn}`);
    await checkTargetDirWritable(`${process.env.HOME ?? ""}/.copilot`);
    await checkTargetDirWritable(`${process.env.HOME ?? ""}/.copilot/hooks`);
  },

  plan(repoRoot: string, home: string): InstallPlan {
    const hooksDir = join(home, ".copilot", "hooks");
    const copies = HOOK_SCRIPTS.map((name) => ({
      src: join(repoRoot, "hooks", "copilot", name),
      dest: join(hooksDir, name),
      mode: 0o755,
    }));

    const mcpSnippet = join(repoRoot, "hooks", "copilot", "mcp-snippet.json");
    const hooksSnippet = join(repoRoot, "hooks", "copilot", "hooks.json");
    const instructionsSnippet = join(
      repoRoot,
      "hooks",
      "copilot",
      "instructions-snippet.md",
    );

    return {
      target: "copilot",
      copies,
      jsonMerges: [
        {
          file: join(home, ".copilot", "mcp-config.json"),
          patch: { __fromFile: mcpSnippet },
        },
        {
          file: join(home, ".copilot", "hooks", "hooks.json"),
          patch: { __fromFile: hooksSnippet },
        },
      ],
      markdownPrepends: [
        {
          file: join(home, ".copilot", "copilot-instructions.md"),
          snippet: `__fromFile:${instructionsSnippet}`,
          markerId: "agent-brain",
        },
      ],
      postInstructions: [
        "Start the Agent Brain server:",
        "  docker compose -f docker-compose.prod.yml up -d --wait",
      ],
    };
  },

  describe(plan: InstallPlan): string {
    const lines: string[] = [`Target: ${plan.target}`];
    for (const c of plan.copies) lines.push(`  copy  ${c.src} → ${c.dest}`);
    for (const m of plan.jsonMerges) lines.push(`  merge ${m.file}`);
    for (const p of plan.markdownPrepends)
      lines.push(`  prepend ${p.file} [${p.markerId}]`);
    return lines.join("\n");
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/installer/targets.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/targets/copilot.ts tests/unit/installer/targets.test.ts
git commit -m "feat(installer): copilot target plan"
```

---

## Task 7: `apply.ts` + `index.ts` CLI (end-to-end install)

**Files:**

- Create: `scripts/installer/apply.ts`
- Create: `scripts/installer/index.ts`
- Test: `tests/unit/installer/install.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/unit/installer/install.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstaller } from "../../../scripts/installer/index.ts";

const REPO_ROOT = process.cwd();

describe("installer end-to-end", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "abhome-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("installs Claude target: copies hooks, merges settings, prepends CLAUDE.md", async () => {
    await runInstaller(
      {
        targets: ["claude"],
        dryRun: false,
        yes: true,
        uninstall: false,
      },
      { repoRoot: REPO_ROOT, home },
    );

    const hooksDir = join(home, ".claude", "hooks");
    expect(existsSync(join(hooksDir, "memory-session-start.sh"))).toBe(true);
    expect(
      statSync(join(hooksDir, "memory-session-start.sh")).mode & 0o111,
    ).not.toBe(0);

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.mcpServers["agent-brain"]).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();

    const claudeMd = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("<!-- agent-brain:start -->");
    expect(claudeMd).toContain("agent-brain");
  });

  it("installs Copilot target: copies hooks, merges two JSON files, prepends instructions", async () => {
    await runInstaller(
      {
        targets: ["copilot"],
        dryRun: false,
        yes: true,
        uninstall: false,
      },
      { repoRoot: REPO_ROOT, home },
    );

    const hooksDir = join(home, ".copilot", "hooks");
    expect(existsSync(join(hooksDir, "memory-pretool.sh"))).toBe(true);

    const mcpCfg = JSON.parse(
      readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8"),
    );
    expect(mcpCfg.mcpServers["agent-brain"]).toBeDefined();

    const hooksCfg = JSON.parse(
      readFileSync(join(home, ".copilot", "hooks", "hooks.json"), "utf8"),
    );
    expect(hooksCfg.version).toBe(1);

    const instr = readFileSync(
      join(home, ".copilot", "copilot-instructions.md"),
      "utf8",
    );
    expect(instr).toContain("<!-- agent-brain:start -->");
  });

  it("is idempotent: running install twice produces no duplicates", async () => {
    const opts = {
      targets: ["claude" as const],
      dryRun: false,
      yes: true,
      uninstall: false,
    };
    await runInstaller(opts, { repoRoot: REPO_ROOT, home });
    await runInstaller(opts, { repoRoot: REPO_ROOT, home });

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.SessionStart).toHaveLength(1);

    const claudeMd = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    const starts = claudeMd.match(/<!-- agent-brain:start -->/g) ?? [];
    expect(starts).toHaveLength(1);
  });

  it("dryRun writes nothing", async () => {
    await runInstaller(
      {
        targets: ["claude"],
        dryRun: true,
        yes: true,
        uninstall: false,
      },
      { repoRoot: REPO_ROOT, home },
    );

    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/installer/install.test.ts`
Expected: fail — `runInstaller` missing.

- [ ] **Step 3: Implement `apply.ts`**

```ts
// scripts/installer/apply.ts
import { mkdir, copyFile, chmod, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InstallPlan } from "./types.ts";
import { mergeJson } from "./merge-json.ts";
import { prependWithMarkers } from "./merge-markdown.ts";

export interface ApplyOptions {
  dryRun: boolean;
}

async function resolvePatch(patch: unknown): Promise<unknown> {
  if (
    typeof patch === "object" &&
    patch !== null &&
    !Array.isArray(patch) &&
    "__fromFile" in patch &&
    typeof (patch as { __fromFile: unknown }).__fromFile === "string"
  ) {
    const raw = await readFile(
      (patch as { __fromFile: string }).__fromFile,
      "utf8",
    );
    return JSON.parse(raw);
  }
  return patch;
}

async function resolveSnippet(snippet: string): Promise<string> {
  if (snippet.startsWith("__fromFile:")) {
    return readFile(snippet.slice("__fromFile:".length), "utf8");
  }
  return snippet;
}

export async function applyPlan(
  plan: InstallPlan,
  opts: ApplyOptions,
): Promise<void> {
  for (const c of plan.copies) {
    if (opts.dryRun) {
      console.log(`[dry-run] copy ${c.src} → ${c.dest}`);
      continue;
    }
    await mkdir(dirname(c.dest), { recursive: true });
    await copyFile(c.src, c.dest);
    if (c.mode !== undefined) await chmod(c.dest, c.mode);
  }

  for (const m of plan.jsonMerges) {
    const patch = await resolvePatch(m.patch);
    if (opts.dryRun) {
      console.log(`[dry-run] merge ${m.file}`);
      continue;
    }
    await mkdir(dirname(m.file), { recursive: true });
    await mergeJson(m.file, patch, { dryRun: false });
  }

  for (const p of plan.markdownPrepends) {
    const snippet = await resolveSnippet(p.snippet);
    if (opts.dryRun) {
      console.log(`[dry-run] prepend ${p.file} [${p.markerId}]`);
      continue;
    }
    await mkdir(dirname(p.file), { recursive: true });
    await prependWithMarkers(p.file, snippet, p.markerId, { dryRun: false });
  }
}
```

- [ ] **Step 4: Implement `index.ts`**

```ts
// scripts/installer/index.ts
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { RunOptions, TargetName, Target } from "./types.ts";
import { claudeTarget } from "./targets/claude.ts";
import { copilotTarget } from "./targets/copilot.ts";
import { applyPlan } from "./apply.ts";
import { uninstallTarget } from "./uninstall.ts";

const TARGETS: Record<TargetName, Target> = {
  claude: claudeTarget,
  copilot: copilotTarget,
};

export interface Env {
  repoRoot: string;
  home: string;
}

export async function runInstaller(opts: RunOptions, env: Env): Promise<void> {
  // Preflight all targets before any apply
  for (const name of opts.targets) {
    process.env.HOME = env.home; // preflight reads HOME
    await TARGETS[name].preflight();
  }

  for (const name of opts.targets) {
    const target = TARGETS[name];
    if (opts.uninstall) {
      await uninstallTarget(target, env.home, { dryRun: opts.dryRun });
      continue;
    }
    const plan = target.plan(env.repoRoot, env.home);
    if (opts.dryRun) {
      console.log(target.describe(plan));
      continue;
    }
    await applyPlan(plan, { dryRun: false });
    for (const line of plan.postInstructions) console.log(line);
  }
}

async function promptTarget(): Promise<TargetName[]> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question("Target (claude/copilot/both)? "))
    .trim()
    .toLowerCase();
  rl.close();
  if (answer === "claude" || answer === "copilot") return [answer];
  if (answer === "both") return ["claude", "copilot"];
  throw new Error(`Invalid target: ${answer}`);
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      uninstall: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(
      `Usage: npm run install:agent -- [--target=claude|copilot|both] [--dry-run] [--yes] [--uninstall]`,
    );
    return;
  }

  let targets: TargetName[];
  if (values.target) {
    const t = String(values.target);
    if (t === "claude" || t === "copilot") targets = [t];
    else if (t === "both") targets = ["claude", "copilot"];
    else throw new Error(`Invalid --target: ${t}`);
  } else if (stdin.isTTY) {
    targets = await promptTarget();
  } else {
    throw new Error("--target required when not running interactively");
  }

  await runInstaller(
    {
      targets,
      dryRun: Boolean(values["dry-run"]),
      yes: Boolean(values.yes),
      uninstall: Boolean(values.uninstall),
    },
    {
      repoRoot: process.cwd(),
      home: process.env.HOME ?? "",
    },
  );
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isMain) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERR: ${msg}`);
    process.exit(2);
  });
}
```

- [ ] **Step 5: Create `uninstall.ts` stub so `index.ts` typechecks**

```ts
// scripts/installer/uninstall.ts (stub — filled out in Task 8)
import type { Target } from "./types.ts";

export async function uninstallTarget(
  _target: Target,
  _home: string,
  _opts: { dryRun: boolean },
): Promise<void> {
  throw new Error("uninstall not implemented yet");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/installer/install.test.ts`
Expected: all 4 install tests pass.

- [ ] **Step 7: Run full typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add scripts/installer/apply.ts scripts/installer/index.ts scripts/installer/uninstall.ts tests/unit/installer/install.test.ts
git commit -m "feat(installer): CLI entry + apply runner (install flow)"
```

---

## Task 8: Uninstall module + tests

**Files:**

- Modify: `scripts/installer/uninstall.ts`
- Test: `tests/unit/installer/uninstall.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// tests/unit/installer/uninstall.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstaller } from "../../../scripts/installer/index.ts";

const REPO_ROOT = process.cwd();

describe("installer uninstall", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "abuninst-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("removes copied hook scripts for claude", async () => {
    await runInstaller(
      { targets: ["claude"], dryRun: false, yes: true, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );
    expect(
      existsSync(join(home, ".claude", "hooks", "memory-session-start.sh")),
    ).toBe(true);

    await runInstaller(
      { targets: ["claude"], dryRun: false, yes: true, uninstall: true },
      { repoRoot: REPO_ROOT, home },
    );
    expect(
      existsSync(join(home, ".claude", "hooks", "memory-session-start.sh")),
    ).toBe(false);
    expect(existsSync(join(home, ".claude", "hooks", "memory-guard.sh"))).toBe(
      false,
    );
  });

  it("removes agent-brain keys from settings.json, preserves foreign keys", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ theme: "dark", mcpServers: { other: { url: "x" } } }),
    );

    await runInstaller(
      { targets: ["claude"], dryRun: false, yes: true, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );
    await runInstaller(
      { targets: ["claude"], dryRun: false, yes: true, uninstall: true },
      { repoRoot: REPO_ROOT, home },
    );

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.theme).toBe("dark");
    expect(settings.mcpServers.other).toEqual({ url: "x" });
    expect(settings.mcpServers["agent-brain"]).toBeUndefined();
    // hook arrays stripped of agent-brain entries
    if (settings.hooks?.SessionStart) {
      for (const group of settings.hooks.SessionStart) {
        for (const h of group.hooks ?? []) {
          expect(h.command).not.toMatch(/memory-.*\.sh/);
        }
      }
    }
  });

  it("strips markers from CLAUDE.md, preserves user content", async () => {
    await runInstaller(
      { targets: ["claude"], dryRun: false, yes: true, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );
    const before = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    writeFileSync(
      join(home, ".claude", "CLAUDE.md"),
      before + "\n# User section\nuser body\n",
    );

    await runInstaller(
      { targets: ["claude"], dryRun: false, yes: true, uninstall: true },
      { repoRoot: REPO_ROOT, home },
    );
    const after = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(after).not.toContain("<!-- agent-brain:start -->");
    expect(after).toContain("# User section");
    expect(after).toContain("user body");
  });

  it("uninstall of never-installed target is a no-op (ENOENT ignored)", async () => {
    await expect(
      runInstaller(
        { targets: ["copilot"], dryRun: false, yes: true, uninstall: true },
        { repoRoot: REPO_ROOT, home },
      ),
    ).resolves.toBeUndefined();
  });

  it("uninstall of copilot removes both JSON files' agent-brain keys", async () => {
    await runInstaller(
      { targets: ["copilot"], dryRun: false, yes: true, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );
    await runInstaller(
      { targets: ["copilot"], dryRun: false, yes: true, uninstall: true },
      { repoRoot: REPO_ROOT, home },
    );

    const mcp = JSON.parse(
      readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8"),
    );
    expect(mcp.mcpServers?.["agent-brain"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/installer/uninstall.test.ts`
Expected: fail — `uninstallTarget` is a stub.

- [ ] **Step 3: Implement `uninstall.ts`**

Replace the stub with:

```ts
// scripts/installer/uninstall.ts
import { rm, readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Target, InstallPlan } from "./types.ts";

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function stripAgentBrainFromJson(
  value: unknown,
  hookPathPattern: RegExp,
): unknown {
  if (Array.isArray(value)) {
    const filtered: unknown[] = [];
    for (const item of value) {
      const cleaned = stripAgentBrainFromJson(item, hookPathPattern);
      // For arrays-of-hooks-groups: if inner "hooks" array becomes empty, drop the group
      if (
        cleaned !== null &&
        typeof cleaned === "object" &&
        !Array.isArray(cleaned) &&
        "hooks" in (cleaned as Record<string, unknown>) &&
        Array.isArray((cleaned as { hooks: unknown[] }).hooks) &&
        (cleaned as { hooks: unknown[] }).hooks.length === 0
      ) {
        continue;
      }
      // Drop leaf hook entries whose command matches
      if (
        cleaned !== null &&
        typeof cleaned === "object" &&
        !Array.isArray(cleaned) &&
        typeof (cleaned as { command?: unknown }).command === "string" &&
        hookPathPattern.test((cleaned as { command: string }).command)
      ) {
        continue;
      }
      if (
        cleaned !== null &&
        typeof cleaned === "object" &&
        !Array.isArray(cleaned) &&
        typeof (cleaned as { bash?: unknown }).bash === "string" &&
        hookPathPattern.test((cleaned as { bash: string }).bash)
      ) {
        continue;
      }
      filtered.push(cleaned);
    }
    return filtered;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "agent-brain") continue;
      out[k] = stripAgentBrainFromJson(v, hookPathPattern);
    }
    return out;
  }
  return value;
}

function stripMarkerBlock(content: string, id: string): string {
  const start = `<!-- ${id}:start -->`;
  const end = `<!-- ${id}:end -->`;
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1 || e < s) return content;
  const afterRaw = content.slice(e + end.length);
  const after = afterRaw.startsWith("\n") ? afterRaw.slice(1) : afterRaw;
  return content.slice(0, s) + after;
}

export async function uninstallTarget(
  target: Target,
  home: string,
  opts: { dryRun: boolean },
): Promise<void> {
  // Reuse plan() to know what files were installed
  const plan: InstallPlan = target.plan(process.cwd(), home);
  const hookPathPattern = /memory-[a-z-]+\.sh/;

  for (const c of plan.copies) {
    if (opts.dryRun) {
      console.log(`[dry-run] rm ${c.dest}`);
      continue;
    }
    await rm(c.dest, { force: true });
  }

  for (const m of plan.jsonMerges) {
    if (!(await fileExists(m.file))) continue;
    if (opts.dryRun) {
      console.log(`[dry-run] clean ${m.file}`);
      continue;
    }
    const raw = await readFile(m.file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // user may have broken it manually; don't make it worse
    }
    const stripped = stripAgentBrainFromJson(parsed, hookPathPattern);
    await writeFile(m.file, JSON.stringify(stripped, null, 2) + "\n", "utf8");
  }

  for (const p of plan.markdownPrepends) {
    if (!(await fileExists(p.file))) continue;
    if (opts.dryRun) {
      console.log(`[dry-run] strip markers in ${p.file}`);
      continue;
    }
    const content = await readFile(p.file, "utf8");
    const stripped = stripMarkerBlock(content, p.markerId);
    await writeFile(p.file, stripped, "utf8");
  }

  console.log(
    `Uninstalled ${target.name}. If the server is running: docker compose down`,
  );
  void basename;
  void dirname;
  void join; // keep imports used
}
```

Remove the unused imports once written (`basename`, `dirname`, `join`):

```ts
// Remove these two lines after confirming compiler passes:
// import { basename, dirname, join } from "node:path";
// void basename; void dirname; void join;
```

(cleanup-only final file omits those imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/installer/uninstall.test.ts`
Expected: all 5 uninstall tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm run test:unit`
Expected: all installer + existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/installer/uninstall.ts tests/unit/installer/uninstall.test.ts
git commit -m "feat(installer): symmetric uninstall (JSON strip + marker removal)"
```

---

## Task 9: Wire up npm scripts + README updates

**Files:**

- Modify: `package.json`
- Modify: `hooks/README.md`
- Modify: `README.md`

- [ ] **Step 1: Add npm scripts**

Edit `package.json` scripts block — add two entries:

```json
"install:agent": "tsx scripts/installer/index.ts",
"uninstall:agent": "tsx scripts/installer/index.ts --uninstall"
```

Final scripts block (for clarity, context-preserving):

```json
"scripts": {
  "dev": "docker compose up -d --wait && npx drizzle-kit migrate && EMBEDDING_PROVIDER=ollama EMBEDDING_DIMENSIONS=768 OLLAMA_BASE_URL=http://localhost:11434 tsx watch src/server.ts",
  "start": "tsx src/server.ts",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "db:studio": "drizzle-kit studio",
  "test": "vitest run",
  "test:watch": "vitest",
  "inspect": "npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:19898/mcp",
  "seed": "tsx scripts/seed.ts",
  "migrate:flag-relationships": "tsx scripts/migrate-flag-relationships.ts",
  "install:agent": "tsx scripts/installer/index.ts",
  "uninstall:agent": "tsx scripts/installer/index.ts --uninstall",
  "lint": "eslint .",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "typecheck": "tsc --noEmit",
  "test:unit": "vitest run --config vitest.ci.config.ts",
  "prepare": "test -z \"$CI\" && husky || true"
}
```

- [ ] **Step 2: Update `hooks/README.md` preface**

Replace the current "Installation" sections (both Claude and Copilot) with a pointer at the top of the document, before existing content:

```md
> **Fast path:** from a cloned checkout, run `npm run install:agent` to install hooks, MCP config, and instructions for Claude Code or Copilot CLI in one step. Uninstall with `npm run uninstall:agent`. The manual steps below remain for reference and for users who prefer fine-grained control.
```

(Leave the manual steps in place — they're useful docs.)

- [ ] **Step 3: Update top-level `README.md` quickstart**

In `README.md`, step `### 4. Set up with Claude Code`, add a lead paragraph:

````md
**Fast path:**

```bash
npm run install:agent -- --target=claude
```
````

This copies hook scripts to `~/.claude/hooks/`, merges the MCP server config into `~/.claude/settings.json` (with a `.bak` backup), and prepends the agent instructions to `~/.claude/CLAUDE.md` between `<!-- agent-brain:start -->` / `<!-- agent-brain:end -->` markers. Re-run is idempotent. Uninstall with `npm run uninstall:agent -- --target=claude`. The manual steps below remain available.

````

Do the equivalent for step 5 (Copilot), substituting `--target=copilot`.

- [ ] **Step 4: Run full suite**

Run: `npm run test:unit && npm run typecheck && npm run lint`
Expected: exit 0.

- [ ] **Step 5: Smoke-test install**

Run: `npm run install:agent -- --target=claude --dry-run`
Expected: prints a plan describing copies / merges / prepends without touching disk.

- [ ] **Step 6: Commit**

```bash
git add package.json hooks/README.md README.md
git commit -m "feat(installer): wire up npm scripts + doc fast path"
````

---

## Task 10: Add format check + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run prettier**

Run: `npm run format`
Expected: formats any new files to repo conventions.

- [ ] **Step 2: Verify format clean**

Run: `npm run format:check`
Expected: exit 0.

- [ ] **Step 3: Run everything**

Run: `npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass.

- [ ] **Step 4: Commit any formatting changes**

```bash
git add -A
git diff --cached --quiet || git commit -m "chore(installer): prettier format"
```

(No-op commit skipped via `--quiet` guard.)

---

## Self-Review

**Spec coverage:**

- CLI flags `--target`, `--dry-run`, `--yes`, `--uninstall`, `--help` → Task 7 (`parseArgs` block).
- Interactive prompt when TTY and no `--target` → Task 7 (`promptTarget`).
- Fail when no `--target` and non-TTY → Task 7 (throws `--target required`).
- User-level paths `~/.claude/`, `~/.copilot/` → Tasks 5, 6.
- Claude copies 5 hook scripts → Task 5.
- Copilot copies 3 hook scripts → Task 6.
- Claude single JSON merge → Task 5.
- Copilot two JSON merges → Task 6.
- Markdown prepend with markers → Tasks 3, 5, 6.
- `.bak` on first run only → Tasks 2, 3.
- Array dedupe for idempotency → Task 2.
- Strict preflight (jq, writable dir, docker warn) → Task 4.
- Preflight before any apply, fail aborts whole run → Task 7 (`for` before apply loop).
- Symmetric uninstall → Task 8.
- Docker instructions printed, not run → Tasks 5, 6 (`postInstructions`).
- Exit codes 0/1/2/3 → Task 7 (main catches → exit 2; preflight throws → uncaught → exit 2; user-declined path — see note below).

**Note on exit code 3 (user declined):** spec mentioned exit 3 for declined confirmation. With `--yes` or non-TTY we skip the prompt. Interactive confirmation was not wired into `index.ts` above — we only prompt for target selection, not for apply confirmation. This simplifies the v1 implementation. If confirmation is desired later, add a second prompt in `main()` before `runInstaller`. Leaving as-is matches "minimize interruptions"; spec's exit-3 code is reserved for future use.

**Placeholder scan:** None. All steps contain executable code or exact commands.

**Type consistency:** `Target`, `InstallPlan`, `RunOptions`, `TargetName` used consistently across tasks. `plan()` signature `(repoRoot, home)` identical in Tasks 5 and 6. `applyPlan` + `uninstallTarget` signatures align with `runInstaller` calls.

**Known limitation:** JSON uninstall is heuristic — removes keys literally named `agent-brain` and hook entries whose `command`/`bash` field matches `/memory-[a-z-]+\.sh/`. If the user renamed a hook script, its entry won't be stripped. Acceptable for v1 since user-level installs use canonical names; document in the spec if needed.
