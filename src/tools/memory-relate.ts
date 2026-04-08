import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RelationshipService } from "../services/relationship-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";
import { WELL_KNOWN_RELATIONSHIP_TYPES } from "../types/relationship.js";

const wellKnownList = WELL_KNOWN_RELATIONSHIP_TYPES.join(", ");

export function registerMemoryRelate(
  server: McpServer,
  relationshipService: RelationshipService,
): void {
  server.registerTool(
    "memory_relate",
    {
      description: `Create a directional relationship between two memories. Well-known types: ${wellKnownList}. You may also use any descriptive string for novel relationship types.`,
      inputSchema: {
        source_id: z.string().describe("ID of the source memory"),
        target_id: z.string().describe("ID of the target memory"),
        type: z
          .string()
          .min(1)
          .max(64)
          .describe(
            `Relationship type. Well-known: ${wellKnownList}. Any descriptive string is also valid.`,
          ),
        description: z
          .string()
          .max(500)
          .optional()
          .describe("Optional human-readable description of the relationship"),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Confidence score between 0 and 1 (default: 1.0)"),
        user_id: slugSchema.describe("Who is creating the relationship"),
        created_via: z
          .string()
          .optional()
          .describe("System or tool that created this relationship"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await relationshipService.create({
          sourceId: params.source_id,
          targetId: params.target_id,
          type: params.type,
          description: params.description,
          confidence: params.confidence,
          userId: params.user_id,
          createdVia: params.created_via,
        });
        return toolResponse({ data: result, meta: {} });
      });
    },
  );
}
