#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "src", "server.ts");

const result = spawnSync(
  process.execPath,
  ["--import", "tsx/esm", serverPath],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);
