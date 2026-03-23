import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling, validateMemoryType } from "./tool-utils.js";

export function registerMemoryUpdate(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_update",
    {
      description:
        'Update an existing memory. Send only the fields you want to change (PATCH-style). Requires version for optimistic locking. Example: memory_update({ id: "abc123", version: 1, content: "Updated content", user_id: "alice" })',
      inputSchema: {
        id: z.string().describe("Memory ID to update"),
        version: z.number().int().describe("Current version of the memory (for optimistic locking, prevents conflicts)"),
        content: z.string().optional().describe("New content text"),
        title: z.string().optional().describe("New title"),
        type: z.string().optional().describe("New memory category type: fact, decision, learning, pattern, preference, architecture"),
        tags: z.array(z.string()).optional().catch(undefined).describe("New tags (replaces existing)"),
        metadata: z.record(z.string(), z.unknown()).optional().describe("New metadata (replaces existing)"),
        user_id: z.string().describe("Who is making this update"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const { id, version, user_id: _userId, ...updates } = params;
        const validatedUpdates = {
          ...updates,
          type: updates.type ? validateMemoryType(updates.type) : undefined,
        };
        const result = await memoryService.update(id, version, validatedUpdates);
        return toolResponse(result);
      });
    },
  );
}
