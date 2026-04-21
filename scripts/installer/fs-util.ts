import { access, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

// Write via temp + rename so SIGKILL/power-loss can't leave a truncated target.
export async function atomicWrite(
  file: string,
  content: string,
): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

// Each call produces a fresh timestamped backup so subsequent installs don't
// clobber the last-known-good. Caller decides whether the source existed.
export async function writeBackup(file: string): Promise<string> {
  const now = new Date();
  const stamp =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    "-" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
  const bak = `${file}.bak.${stamp}`;
  const { copyFile } = await import("node:fs/promises");
  await copyFile(file, bak);
  return bak;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
