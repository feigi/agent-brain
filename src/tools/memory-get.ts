import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryGet(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_get",
    {
      description: 'Retrieve a specific memory by its ID. Example: memory_get({ id: "abc123" })',
      inputSchema: {
        id: z.string().describe("Memory ID to retrieve"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.get(params.id);
        return toolResponse(result);
      });
    },
  );
}
