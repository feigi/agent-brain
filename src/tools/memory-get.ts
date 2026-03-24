import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryGet(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_get",
    {
      description:
        'Retrieve a specific memory by ID. Returns full details including comments array and capability booleans (can_comment, can_edit, can_archive, can_verify). user_id is required for access control and capability computation. Example: memory_get({ id: "abc123", user_id: "alice" })',
      inputSchema: {
        id: z.string().describe("Memory ID to retrieve"),
        user_id: slugSchema.describe(
          "User identifier (e.g., 'alice'). Required for access control and capability computation.",
        ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.getWithComments(
          params.id,
          params.user_id,
        );
        return toolResponse(result);
      });
    },
  );
}
