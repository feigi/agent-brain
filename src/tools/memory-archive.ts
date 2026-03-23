import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryArchive(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_archive",
    {
      description:
        'Archive one or more memories (soft delete). Archived memories are excluded from search. Example: memory_archive({ ids: "abc123", user_id: "alice" }) or memory_archive({ ids: ["abc123", "def456"], user_id: "alice" })',
      inputSchema: {
        ids: z.union([z.string(), z.array(z.string())]).describe("Memory ID or array of IDs to archive"),
        user_id: z.string().describe("Who is archiving"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.archive(params.ids);
        return toolResponse(result);
      });
    },
  );
}
