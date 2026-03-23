import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryArchive(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_archive",
    {
      description:
        'Archive one or more memories (soft delete). Archived memories are excluded from search. user_id is required for access control -- only the owner can archive user-scoped memories. Example: memory_archive({ ids: "abc123", user_id: "alice" }) or memory_archive({ ids: ["abc123", "def456"], user_id: "alice" })',
      inputSchema: {
        ids: z.union([z.string(), z.array(z.string())]).describe("Memory ID or array of IDs to archive"),
        user_id: slugSchema.describe("Who is archiving (e.g., 'alice'). Required for access control."),
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
