import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";
import { userIdSchema, contentSchema } from "../utils/validation.js";

export function registerMemoryComment(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_comment",
    {
      // D-69: Description with usage example and guidance
      description:
        "Add comment to existing memory. Use for context, follow-up, or discussion. " +
        "To correct memory itself, use memory_update. " +
        "Comments are append-only — cannot edit or delete. " +
        "Cannot comment on own memories. " +
        'Example: memory_comment({ memory_id: "abc123", content: "Confirmed this is still the case after migration.", user_id: "bob" })',
      inputSchema: {
        memory_id: z.string().describe("ID of memory to comment on"),
        content: contentSchema.describe(
          "Comment text. Soft limit ~1000 chars.",
        ),
        user_id: userIdSchema,
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.addComment(
          params.memory_id,
          params.user_id,
          params.content,
        );
        return toolResponse(result);
      });
    },
  );
}
