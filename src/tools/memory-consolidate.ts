import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsolidationService } from "../services/consolidation-service.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryConsolidate(
  server: McpServer,
  consolidationService: ConsolidationService,
): void {
  server.registerTool(
    "memory_consolidate",
    {
      description:
        "Run full memory consolidation pass across all workspaces. Auto-archives near-exact duplicates (0.95+), flags probable duplicates (0.90-0.95), flags superseded cross-scope memories, flags stale memories needing verification. Returns counts of archived + flagged memories plus enriched flag details.",
      inputSchema: {},
    },
    async () => {
      return withErrorHandling(async () => {
        const start = Date.now();
        const result = await consolidationService.run();
        const timing = Date.now() - start;
        return toolResponse({ data: result, meta: { timing } });
      });
    },
  );
}
