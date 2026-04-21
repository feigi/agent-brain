import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { userIdSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryVerify(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_verify",
    {
      description:
        'Mark memory as still accurate. Updates verified_at timestamp, records verifier. user_id required. Project-scoped memories verifiable by anyone; user-scoped only by owner. Example: memory_verify({ id: "abc123", user_id: "alice" })',
      inputSchema: {
        id: z.string().describe("Memory ID to verify"),
        user_id: userIdSchema,
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
