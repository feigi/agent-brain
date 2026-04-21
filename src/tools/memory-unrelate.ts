import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RelationshipService } from "../services/relationship-service.js";
import { userIdSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryUnrelate(
  server: McpServer,
  relationshipService: RelationshipService,
): void {
  server.registerTool(
    "memory_unrelate",
    {
      description:
        'Remove (soft-delete) relationship by ID. Archived and excluded from all queries. Example: memory_unrelate({ id: "abc123", user_id: "alice" })',
      inputSchema: {
        id: z.string().describe("Relationship ID to remove"),
        user_id: userIdSchema,
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        await relationshipService.remove(params.id, params.user_id);
        return toolResponse({ data: { success: true }, meta: {} });
      });
    },
  );
}
