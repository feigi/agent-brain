import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VaultIndex } from "./repositories/vault-index.js";
import type { FlagService } from "../../services/flag-service.js";
import type {
  ParseErrorChecker,
  ParseErrorCheckResult,
} from "../../services/consolidation-service.js";
import { parseMemoryFile } from "./parser/memory-parser.js";
import { logger } from "../../utils/logger.js";

export class VaultParseErrorChecker implements ParseErrorChecker {
  constructor(
    private readonly vaultIndex: VaultIndex,
    private readonly root: string,
    private readonly flagService: FlagService,
  ) {}

  async check(): Promise<ParseErrorCheckResult> {
    const errors: ParseErrorCheckResult["errors"] = [];
    const resolvable: ParseErrorCheckResult["resolvable"] = [];

    for (const [id, entry] of this.vaultIndex.entries()) {
      const abs = join(this.root, entry.path);
      let raw: string;
      try {
        raw = await readFile(abs, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") {
          // File gone — path-consistency checker owns deleted-file surfacing.
          continue;
        }
        logger.error(
          `parse-error-checker: readFile failed for ${entry.path} (${code ?? "unknown"}):`,
          err,
        );
        continue;
      }

      let parseOk = true;
      let reason = "";
      try {
        parseMemoryFile(raw);
      } catch (err) {
        parseOk = false;
        reason = err instanceof Error ? err.message : String(err);
      }

      if (parseOk) {
        const flags = await this.flagService.getFlagsByMemoryId(id);
        for (const f of flags) {
          if (f.flag_type === "parse_error" && f.resolved_at === null) {
            resolvable.push({ memoryId: id, flagId: f.id });
          }
        }
      } else {
        const alreadyFlagged = await this.flagService.hasOpenFlag(
          id,
          "parse_error",
        );
        if (!alreadyFlagged) {
          errors.push({ memoryId: id, path: entry.path, reason });
        }
      }
    }

    return { errors, resolvable };
  }
}
