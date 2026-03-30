import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";
import { slugSchema } from "../utils/validation.js";

export function registerMemoryListRecent(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_list_recent",
    {
      description:
        "List memories created or updated after a given timestamp. Useful for team activity awareness. " +
        "Each result includes a change_type indicating whether it was created, updated, or commented. " +
        'Example: memory_list_recent({ workspace_id: "my-project", user_id: "alice", since: "2026-03-20T00:00:00Z" })',
      inputSchema: {
        workspace_id: slugSchema.describe("Workspace slug"),
        user_id: slugSchema.describe(
          "User identifier (required for scope-based privacy)",
        ),
        since: z
          .string()
          .datetime()
          .describe("ISO timestamp -- return memories changed after this time"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Max results (default 10)"),
        exclude_self: z
          .boolean()
          .default(false)
          .describe(
            "When true, exclude memories authored by you (useful for 'what did teammates do?')",
          ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const sinceDate = new Date(params.since);
        const result = await memoryService.listRecentActivity(
          params.workspace_id,
          params.user_id,
          sinceDate,
          params.limit,
          params.exclude_self,
        );
        return toolResponse(result);
      });
    },
  );
}
