import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema, contentSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryUpdate(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_update",
    {
      description:
        'Update an existing memory. Send only the fields you want to change (PATCH-style). Requires version for optimistic locking. user_id is required for access control -- only the owner can update user-scoped memories. Example: memory_update({ id: "abc123", version: 1, content: "Updated content", user_id: "alice" })',
      inputSchema: {
        id: z.string().describe("Memory ID to update"),
        version: z
          .number()
          .int()
          .describe(
            "Current version of the memory (for optimistic locking, prevents conflicts)",
          ),
        content: contentSchema
          .optional()
          .describe("New content text. Must not be empty if provided."),
        title: z.string().optional().describe("New title"),
        type: z
          .enum([
            "fact",
            "decision",
            "learning",
            "pattern",
            "preference",
            "architecture",
          ])
          .optional()
          .catch(undefined)
          .describe("New memory category type"),
        tags: z
          .array(z.string())
          .optional()
          .catch(undefined)
          .describe("New tags (replaces existing)"),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("New metadata (replaces existing)"),
        user_id: slugSchema.describe(
          "Who is making this update (e.g., 'alice'). Required for access control.",
        ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const { id, version, user_id, ...updates } = params;
        const result = await memoryService.update(
          id,
          version,
          updates,
          user_id,
        );
        return toolResponse(result);
      });
    },
  );
}
