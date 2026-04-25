// src/backend/vault/watcher/watcher.ts
import { watch as chokidarWatch } from "chokidar";
import type { FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import { logger } from "../../../utils/logger.js";
import { IgnoreSetImpl } from "./ignore-set.js";
import type { IgnoreSet, ReconcileSignal } from "./types.js";
import type { Reconciler } from "./reconciler.js";

export interface VaultWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly ignoreSet: IgnoreSet;
  hadError(): boolean;
}

export interface CreateVaultWatcherOpts {
  vaultRoot: string;
  reconciler: Reconciler;
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number };
  ignoreSet?: IgnoreSet;
}

export function createVaultWatcher(opts: CreateVaultWatcherOpts): VaultWatcher {
  const ignoreSet = opts.ignoreSet ?? new IgnoreSetImpl();
  const awaitWriteFinish = opts.awaitWriteFinish ?? {
    stabilityThreshold: 300,
    pollInterval: 100,
  };

  let watcher: FSWatcher | null = null;
  let inFlight = 0;
  let drainResolvers: Array<() => void> = [];
  let _hadError = false;

  const dispatch = async (
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<void> => {
    inFlight++;
    try {
      let currentMtime = 0;
      if (signal !== "unlink") {
        try {
          const s = await stat(absPath);
          currentMtime = Number(s.mtime);
        } catch {
          // best-effort — file may have been removed before stat
        }
      }
      if (ignoreSet.has(absPath, currentMtime)) return;
      try {
        await opts.reconciler.reconcileFile(absPath, signal);
      } catch (err) {
        logger.error(`watcher: reconcileFile threw for ${absPath}`, { err });
      }
    } finally {
      inFlight--;
      if (inFlight === 0 && drainResolvers.length > 0) {
        const r = drainResolvers;
        drainResolvers = [];
        for (const fn of r) fn();
      }
    }
  };

  return {
    ignoreSet,
    hadError: () => _hadError,
    async start() {
      watcher = chokidarWatch(`${opts.vaultRoot}/**/*.md`, {
        ignoreInitial: true,
        awaitWriteFinish,
      });
      watcher.on("add", (p: string) => void dispatch(p, "add"));
      watcher.on("change", (p: string) => void dispatch(p, "change"));
      watcher.on("unlink", (p: string) => void dispatch(p, "unlink"));
      watcher.on("error", (err: unknown) => {
        _hadError = true;
        logger.error("watcher: chokidar emitted error", { err });
      });
      await new Promise<void>((resolve) => {
        watcher!.on("ready", () => resolve());
      });
    },
    async stop() {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      if (inFlight === 0) return;
      await new Promise<void>((resolve) => {
        drainResolvers.push(resolve);
      });
    },
  };
}
