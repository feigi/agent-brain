import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryVerify(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_verify",
    {
      description:
        'Mark a memory as still accurate. Updates the verified_at timestamp and records who verified it. user_id is required. Project-scoped memories can be verified by anyone; user-scoped memories only by the owner. Example: memory_verify({ id: "abc123", user_id: "alice" })',
      inputSchema: {
        id: z.string().describe("Memory ID to verify"),
        user_id: slugSchema.describe(
          "User identifier (e.g., 'alice'). Required for provenance and access control.",
        ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.verify(params.id, params.user_id);
        return toolResponse(result);
      });
    },
  );
}
