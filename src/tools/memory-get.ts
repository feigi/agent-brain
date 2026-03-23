import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryGet(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_get",
    {
      description:
        'Retrieve a specific memory by its ID. user_id is required for access control. User-scoped memories owned by others return not-found. Example: memory_get({ id: "abc123", user_id: "alice" })',
      inputSchema: {
        id: z.string().describe("Memory ID to retrieve"),
        user_id: slugSchema.describe("User identifier (e.g., 'alice'). Required for access control."),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.get(params.id, params.user_id);
        return toolResponse(result);
      });
    },
  );
}
