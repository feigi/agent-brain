import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RelationshipService } from "../services/relationship-service.js";
import { userIdSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryRelationships(
  server: McpServer,
  relationshipService: RelationshipService,
): void {
  server.registerTool(
    "memory_relationships",
    {
      description:
        'List relationships for memories. Returns all in requested direction, optionally filtered by type. Example: memory_relationships({ memory_ids: ["abc123", "def456"], user_id: "alice", direction: "both" })',
      inputSchema: {
        memory_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .describe("Memory IDs to list relationships for (max 100)"),
        direction: z
          .enum(["outgoing", "incoming", "both"])
          .default("both")
          .describe(
            'Direction: "outgoing" (memory is source), "incoming" (memory is target), or "both" (default)',
          ),
        type: z.string().optional().describe("Relationship type filter"),
        user_id: userIdSchema,
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const start = Date.now();
        const { relationships, omitted } =
          await relationshipService.listForMemories(
            params.memory_ids,
            params.direction,
            params.user_id,
            params.type,
          );
        return toolResponse({
          data: relationships,
          meta: {
            count: relationships.length,
            timing: Date.now() - start,
            omitted: omitted.length > 0 ? omitted : undefined,
          },
        });
      });
    },
  );
}
