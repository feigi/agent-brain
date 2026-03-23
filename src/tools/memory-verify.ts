import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryVerify(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_verify",
    {
      description:
        'Mark a memory as still accurate. Updates the verified_at timestamp. Use when you\'ve confirmed a memory\'s content is still correct. Example: memory_verify({ id: "abc123", user_id: "alice" })',
      inputSchema: {
        id: z.string().describe("Memory ID to verify"),
        user_id: z.string().describe("User ID of the person verifying the memory"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.verify(params.id, params.user_id);
        return toolResponse(result);
      });
    },
  );
}
