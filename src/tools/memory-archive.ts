import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { userIdSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryArchive(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_archive",
    {
      description:
        'Archive memories (soft delete). Archived memories excluded from search. user_id required — only owner can archive user-scoped memories. Example: memory_archive({ ids: "abc123", user_id: "alice" }) or memory_archive({ ids: ["abc123", "def456"], user_id: "alice" })',
      inputSchema: {
        ids: z
          .union([
            z.string().min(1),
            z.array(z.string().min(1)).min(1).max(100),
          ])
          .describe("Memory ID or array of IDs to archive (max 100)"),
        user_id: userIdSchema,
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.archive(params.ids, params.user_id);
        return toolResponse(result);
      });
    },
  );
}
