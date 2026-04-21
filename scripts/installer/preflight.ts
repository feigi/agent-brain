import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";

const execFile = promisify(execFileCb);

// Do not call onPath() with user-controlled input. `binary` is passed as a
// positional arg to /bin/sh -c, which is safe for literal callers (jq, docker)
// but would enable injection if the caller is ever user-controlled.
async function onPath(binary: string): Promise<boolean> {
  try {
    await execFile("/bin/sh", ["-c", 'command -v "$1"', "--", binary], {
      env: { ...process.env },
    });
    return true;
  } catch (e) {
    const code = (e as { code?: number | string }).code;
    if (code === 1) return false;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to probe PATH for '${binary}': ${msg}`, {
      cause: e,
    });
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
    throw new Error(`${dir} not writable: ${msg}`, { cause: e });
  }
  const probe = join(dir, `.agent-brain-probe-${process.pid}`);
  try {
    await writeFile(probe, "", "utf8");
    await rm(probe, { force: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${dir} not writable: ${msg}`, { cause: e });
  }
}

export async function checkDockerWarn(): Promise<string | null> {
  try {
    if (await onPath("docker")) return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `docker probe failed: ${msg}`;
  }
  return "docker not found on PATH. You'll need it to run the server (see post-install instructions).";
}
