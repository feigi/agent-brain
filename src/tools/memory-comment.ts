import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";
import { slugSchema, contentSchema } from "../utils/validation.js";

export function registerMemoryComment(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_comment",
    {
      // D-69: Description with usage example and guidance
      description:
        "Add a comment to an existing memory. Use to add context, follow-up, or discussion. "
        + "For correcting the memory itself, use memory_update instead. "
        + "Comments are append-only and cannot be edited or deleted. "
        + "Cannot comment on your own memories. "
        + "Example: memory_comment({ memory_id: \"abc123\", content: \"Confirmed this is still the case after migration.\", user_id: \"bob\" })",
      inputSchema: {
        memory_id: z.string().describe("ID of the memory to comment on"),
        content: contentSchema.describe("Comment text. Soft limit ~1000 chars."),
        user_id: slugSchema.describe("Who is commenting (e.g., 'bob')"),
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
