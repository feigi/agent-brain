import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

/** Parse cursor string (format: "created_at|id") into object for the repository layer */
function parseCursor(cursor: string | undefined): { created_at: string; id: string } | undefined {
  if (!cursor) return undefined;
  const sep = cursor.indexOf("|");
  if (sep === -1) return undefined;
  return {
    created_at: cursor.slice(0, sep),
    id: cursor.slice(sep + 1),
  };
}

export function registerMemoryListStale(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_list_stale",
    {
      description:
        'List memories that haven\'t been verified within a threshold. Helps identify knowledge that may be outdated. Example: memory_list_stale({ project_id: "my-project", threshold_days: 30 })',
      inputSchema: {
        project_id: z.string().describe("Project slug"),
        threshold_days: z.number().int().min(1).default(30).describe("Days since last verification (default 30)"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results per page (default 20)"),
        cursor: z.string().optional().describe("Pagination cursor from previous response"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.listStale(
          params.project_id,
          params.threshold_days,
          params.limit,
          parseCursor(params.cursor),
        );
        return toolResponse(result);
      });
    },
  );
}
