import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling, validateMemoryType } from "./tool-utils.js";

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

export function registerMemoryList(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_list",
    {
      description:
        'Browse memories with filtering, sorting, and pagination. Use for browsing by type or tags. For semantic search, use memory_search instead. Example: memory_list({ project_id: "my-project", type: "decision" })',
      inputSchema: {
        project_id: z.string().describe("Project slug"),
        scope: z.enum(["project", "user"]).catch("project").describe("List scope"),
        user_id: z.string().optional().describe("Required when scope is 'user'"),
        type: z.string().optional().describe("Filter by memory type: fact, decision, learning, pattern, preference, architecture"),
        tags: z.array(z.string()).optional().catch(undefined).describe("Filter by tags (memories matching ANY of these tags)"),
        sort_by: z.enum(["created_at", "updated_at"]).catch("created_at").describe("Sort field"),
        order: z.enum(["asc", "desc"]).catch("desc").describe("Sort order"),
        cursor: z.string().optional().describe("Pagination cursor from previous response"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results per page (default 20)"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.list({
          project_id: params.project_id,
          scope: params.scope,
          user_id: params.user_id,
          type: params.type ? validateMemoryType(params.type) : undefined,
          tags: params.tags,
          sort_by: params.sort_by,
          order: params.order,
          cursor: parseCursor(params.cursor),
          limit: params.limit,
        });
        return toolResponse(result);
      });
    },
  );
}
