#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeMemoryFiles } from "../backend/vault/parser/merge-memory.js";
import type { Diff3Result } from "../backend/vault/parser/merge-memory.js";

/**
 * Git merge driver entry point. argv = [%A, %O, %B] (ours, ancestor, theirs)
 * per the driver spec; we rewrite %A with the merged content.
 *
 * Returns 0 on clean merge, 1 on conflict or parse failure.
 */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length < 3) {
    console.error("usage: merge-memory %A %O %B");
    return 1;
  }
  const [ours, ancestor, theirs] = argv as [string, string, string];
  try {
    const [oursBody, ancestorBody, theirsBody] = await Promise.all([
      readFile(ours, "utf8"),
      readFile(ancestor, "utf8"),
      readFile(theirs, "utf8"),
    ]);
    const res = await mergeMemoryFiles(ancestorBody, oursBody, theirsBody, {
      diff3: gitMergeFile,
    });
    if (!res.ok) {
      console.error(`agent-brain-merge-memory: ${res.reason}`);
      return 1;
    }
    await writeFile(ours, res.merged, "utf8");
    return 0;
  } catch (err) {
    console.error(`agent-brain-merge-memory: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * Uses `git merge-file -p` to perform a three-way diff over body text.
 * Returns { clean: true, text } on exit 0 (clean merge),
 *         { clean: false } on exit 1 (conflict markers in output).
 * Throws on exit code > 1 (real error from git).
 */
async function gitMergeFile(
  base: string,
  our: string,
  their: string,
): Promise<Diff3Result> {
  const dir = await mkdtemp(join(tmpdir(), "mm-"));
  try {
    const [basePath, ourPath, theirPath] = await Promise.all([
      writeAndReturn(join(dir, "base"), base),
      writeAndReturn(join(dir, "ours"), our),
      writeAndReturn(join(dir, "theirs"), their),
    ]);

    return await new Promise<Diff3Result>((resolve, reject) => {
      const child = spawn("git", [
        "merge-file",
        "-p",
        ourPath,
        basePath,
        theirPath,
      ]);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.stderr.on("data", () => {}); // suppress git diagnostics
      child.on("error", reject);
      child.on("close", (code) => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (code === 0) resolve({ clean: true, text });
        else if (code === 1) resolve({ clean: false });
        else reject(new Error(`git merge-file exited ${String(code)}`));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeAndReturn(p: string, body: string): Promise<string> {
  await writeFile(p, body, "utf8");
  return p;
}

// ESM main-module guard: run when invoked directly as the CLI entry point.
if (process.argv[1] && process.argv[1].endsWith("merge-memory.js")) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
