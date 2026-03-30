import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemorySessionStart(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_session_start",
    {
      description:
        "Load relevant memories at session start. Searches both project and user scopes. " +
        "user_id is required to load your private memories alongside shared project memories. " +
        "Provide context for relevance-ranked results, or omit for recent memories. " +
        'Example: memory_session_start({ workspace_id: "my-project", user_id: "alice" })',
      inputSchema: {
        workspace_id: slugSchema.describe(
          "Workspace slug (e.g., 'my-project')",
        ),
        user_id: slugSchema.describe(
          "User identifier (e.g., 'alice'). Required to load user-scoped memories.",
        ),
        context: z
          .string()
          .optional()
          .describe(
            "What the agent is working on (used for semantic relevance ranking)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Max memories to return (default 10)"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.sessionStart(
          params.workspace_id,
          params.user_id,
          params.context,
          params.limit,
        );
        return toolResponse(result);
      });
    },
  );
}
