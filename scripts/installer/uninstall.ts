/* eslint-disable @typescript-eslint/no-unused-vars */
import type { Target } from "./types.js";

export async function uninstallTarget(
  _target: Target,
  _home: string,
  _opts: { dryRun: boolean },
): Promise<void> {
  throw new Error("uninstall not implemented yet");
}
