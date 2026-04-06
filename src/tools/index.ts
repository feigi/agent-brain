import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryService } from "../services/memory-service.js";
import type { FlagService } from "../services/flag-service.js";
import type { ConsolidationService } from "../services/consolidation-service.js";
import { registerMemoryCreate } from "./memory-create.js";
import { registerMemoryGet } from "./memory-get.js";
import { registerMemoryUpdate } from "./memory-update.js";
import { registerMemoryArchive } from "./memory-archive.js";
import { registerMemorySearch } from "./memory-search.js";
import { registerMemoryList } from "./memory-list.js";
import { registerMemoryVerify } from "./memory-verify.js";
import { registerMemoryListStale } from "./memory-list-stale.js";
import { registerMemorySessionStart } from "./memory-session-start.js";
import { registerMemoryComment } from "./memory-comment.js";
import { registerMemoryListRecent } from "./memory-list-recent.js";
import { registerMemoryResolveFlag } from "./memory-resolve-flag.js";
import { registerMemoryConsolidate } from "./memory-consolidate.js";

export function registerAllTools(
  server: McpServer,
  memoryService: MemoryService,
  flagService: FlagService,
  consolidationService: ConsolidationService,
): void {
  registerMemoryCreate(server, memoryService);
  registerMemoryGet(server, memoryService);
  registerMemoryUpdate(server, memoryService);
  registerMemoryArchive(server, memoryService);
  registerMemorySearch(server, memoryService);
  registerMemoryList(server, memoryService);
  registerMemoryVerify(server, memoryService);
  registerMemoryListStale(server, memoryService);
  registerMemorySessionStart(server, memoryService);
  registerMemoryComment(server, memoryService);
  registerMemoryListRecent(server, memoryService);
  registerMemoryResolveFlag(server, flagService);
  registerMemoryConsolidate(server, consolidationService);
}
