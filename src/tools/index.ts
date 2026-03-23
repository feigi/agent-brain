import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryService } from "../services/memory-service.js";
import { registerMemoryCreate } from "./memory-create.js";
import { registerMemoryGet } from "./memory-get.js";
import { registerMemoryUpdate } from "./memory-update.js";
import { registerMemoryArchive } from "./memory-archive.js";
import { registerMemorySearch } from "./memory-search.js";
import { registerMemoryList } from "./memory-list.js";
import { registerMemoryVerify } from "./memory-verify.js";
import { registerMemoryListStale } from "./memory-list-stale.js";

export function registerAllTools(server: McpServer, memoryService: MemoryService): void {
  registerMemoryCreate(server, memoryService);
  registerMemoryGet(server, memoryService);
  registerMemoryUpdate(server, memoryService);
  registerMemoryArchive(server, memoryService);
  registerMemorySearch(server, memoryService);
  registerMemoryList(server, memoryService);
  registerMemoryVerify(server, memoryService);
  registerMemoryListStale(server, memoryService);
}
