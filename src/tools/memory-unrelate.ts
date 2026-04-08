import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RelationshipService } from "../services/relationship-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryUnrelate(
  server: McpServer,
  relationshipService: RelationshipService,
): void {
  server.registerTool(
    "memory_unrelate",
    {
      description:
        'Remove a relationship between two memories by relationship ID. Example: memory_unrelate({ id: "abc123", user_id: "alice" })',
      inputSchema: {
        id: z.string().describe("Relationship ID to remove"),
        user_id: slugSchema.describe(
          "Who is removing the relationship (required for access control)",
        ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        await relationshipService.remove(params.id, params.user_id);
        return toolResponse({ success: true });
      });
    },
  );
}
