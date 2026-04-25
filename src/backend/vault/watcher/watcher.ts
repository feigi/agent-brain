// src/backend/vault/watcher/watcher.ts
import { watch as chokidarWatch } from "chokidar";
import type { FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import { basename, sep } from "node:path";
import { logger } from "../../../utils/logger.js";
import { IgnoreSetImpl } from "./ignore-set.js";
import type { IgnoreSet, ReconcileSignal } from "./types.js";
import type { Reconciler } from "./reconciler.js";

export interface WatcherErrorInfo {
  message: string;
  code?: string;
  at: string;
}

export interface VaultWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly ignoreSet: IgnoreSet;
  lastError(): WatcherErrorInfo | null;
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
  let _lastError: WatcherErrorInfo | null = null;

  const dispatch = async (
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<void> => {
    if (!absPath.endsWith(".md")) return;
    inFlight++;
    try {
      let currentMtime = 0;
      if (signal !== "unlink") {
        try {
          const s = await stat(absPath);
          currentMtime = Number(s.mtime);
        } catch (err: unknown) {
          const code = errnoCode(err);
          if (code !== "ENOENT") {
            logger.warn(`watcher: stat failed for ${absPath}`, { err, code });
          }
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
    lastError: () => _lastError,
    async start() {
      // chokidar v4+ removed glob support. Watch the vault root directly
      // and use the `ignored` filter to restrict events to .md files
      // and skip dot-prefix dirs (.git, .agent-brain) which would
      // otherwise burn inotify watches and emit non-md events.
      watcher = chokidarWatch(opts.vaultRoot, {
        ignoreInitial: true,
        awaitWriteFinish,
        ignored: (_path: string, stats?: import("node:fs").Stats) => {
          if (isDotPrefixedSubpath(opts.vaultRoot, _path)) return true;
          if (stats?.isFile() === true && !_path.endsWith(".md")) return true;
          return false;
        },
      });
      watcher.on("add", (p: string) => void dispatch(p, "add"));
      watcher.on("change", (p: string) => void dispatch(p, "change"));
      watcher.on("unlink", (p: string) => void dispatch(p, "unlink"));
      watcher.on("error", (err: unknown) => {
        const code = errnoCode(err);
        const message = err instanceof Error ? err.message : String(err);
        if (_lastError === null) {
          _lastError = {
            message,
            ...(code ? { code } : {}),
            at: new Date().toISOString(),
          };
        }
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

function errnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function isDotPrefixedSubpath(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  const rel = candidate.startsWith(root + sep)
    ? candidate.slice(root.length + 1)
    : candidate;
  for (const seg of rel.split(sep)) {
    if (seg.startsWith(".") && seg !== "." && seg !== "..") return true;
  }
  if (basename(candidate).startsWith(".")) return true;
  return false;
}
