import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";

const execFile = promisify(execFileCb);

async function onPath(binary: string): Promise<boolean> {
  try {
    await execFile("/bin/sh", ["-c", `command -v ${binary}`], {
      env: { ...process.env },
    });
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
  if (await onPath("docker")) return null;
  return "docker not found on PATH. You'll need it to run the server (see post-install instructions).";
}
