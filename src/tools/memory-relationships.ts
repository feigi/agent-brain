import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RelationshipService } from "../services/relationship-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryRelationships(
  server: McpServer,
  relationshipService: RelationshipService,
): void {
  server.registerTool(
    "memory_relationships",
    {
      description:
        'List relationships for one or more memories. Returns all relationships in the requested direction, optionally filtered by type. Example: memory_relationships({ memory_ids: ["abc123", "def456"], user_id: "alice", direction: "both" })',
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
            'Direction to filter: "outgoing" (memory is source), "incoming" (memory is target), or "both" (default)',
          ),
        type: z
          .string()
          .optional()
          .describe("Optional relationship type filter"),
        user_id: slugSchema.describe(
          "User identifier (required for access control)",
        ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const start = Date.now();
        const { relationships, accessibleAnchorIds } =
          await relationshipService.listForMemories(
            params.memory_ids,
            params.direction,
            params.user_id,
            params.type,
          );
        const omitted = [...new Set(params.memory_ids)].filter(
          (id) => !accessibleAnchorIds.has(id),
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
