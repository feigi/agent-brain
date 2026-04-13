import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FlagService } from "../services/flag-service.js";
import { userIdSchema } from "../utils/validation.js";
import { withErrorHandling, toolResponse } from "./tool-utils.js";

export function registerMemoryResolveFlag(
  server: McpServer,
  flagService: FlagService,
): void {
  server.registerTool(
    "memory_resolve_flag",
    {
      description:
        "Resolve a flag on a memory. Use after the user has reviewed a flagged issue " +
        "(duplicate, superseded, verify, etc.) and decided on an action. " +
        "resolution: 'accepted' = acted on, 'dismissed' = false positive, 'deferred' = skip for now. " +
        'Example: memory_resolve_flag({ flag_id: "abc123", user_id: "alice", resolution: "accepted" })',
      inputSchema: {
        flag_id: z.string().min(1).describe("The flag ID to resolve"),
        user_id: userIdSchema,
        resolution: z
          .enum(["accepted", "dismissed", "deferred"])
          .describe("How the flag was resolved"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await flagService.resolveFlag(
          params.flag_id,
          params.user_id,
          params.resolution,
        );
        return toolResponse({ data: result, meta: {} });
      });
    },
  );
}
