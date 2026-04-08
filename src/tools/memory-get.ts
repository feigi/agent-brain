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
        'Retrieve one or more memories by ID. Returns full details with comment_count, flag_count, and relationship_count. Use the include parameter to get full comments, flags, or relationships arrays instead of counts. With include: ["relationships"], there is no need to call memory_relationships separately. For the common "get all memories" flow: memory_list → memory_get. Example: memory_get({ ids: ["abc123"], user_id: "alice", include: ["comments", "relationships"] })',
      inputSchema: {
        ids: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .describe("Memory IDs to retrieve (max 100)"),
        user_id: slugSchema.describe(
          "User identifier (e.g., 'alice'). Required for access control and capability computation.",
        ),
        include: z
          .array(z.enum(["comments", "flags", "relationships"]))
          .optional()
          .describe(
            'Optional: expand these fields to full arrays instead of counts. E.g. ["comments", "relationships"]',
          ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.getMany(
          params.ids,
          params.user_id,
          params.include,
        );
        return toolResponse(result);
      });
    },
  );
}
