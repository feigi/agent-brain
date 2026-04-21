import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema, userIdSchema, parseCursor } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryListStale(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_list_stale",
    {
      description:
        'List memories not verified within threshold. Surfaces possibly outdated knowledge. user_id required — returns workspace/project-scoped memories plus your own user-scoped memories. Example: memory_list_stale({ workspace_id: "my-project", user_id: "alice", threshold_days: 30 })',
      inputSchema: {
        workspace_id: slugSchema.describe(
          "Workspace slug (e.g., 'my-project')",
        ),
        user_id: userIdSchema,
        threshold_days: z
          .number()
          .int()
          .min(1)
          .default(30)
          .describe("Days since last verification (default 30)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Max results per page (default 20)"),
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from previous response"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.listStale(
          params.workspace_id,
          params.user_id,
          params.threshold_days,
          params.limit,
          parseCursor(params.cursor),
        );
        return toolResponse(result);
      });
    },
  );
}
