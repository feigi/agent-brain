import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema, userIdSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemorySessionStart(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_session_start",
    {
      description:
        "Load relevant memories at session start. Searches workspace + user scopes (ranked) and always includes all project-scoped (global) memories. " +
        "user_id is required -- use your OS username in lowercase (run 'whoami' and convert to lowercase if needed). " +
        "Provide context for relevance-ranked results, or omit for recent memories. " +
        'Example: memory_session_start({ workspace_id: "my-project", user_id: "alice" })',
      inputSchema: {
        workspace_id: slugSchema.describe(
          "Workspace slug (e.g., 'my-project')",
        ),
        user_id: userIdSchema,
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
          .describe(
            "Max workspace/user-scoped memories to return (default 10). Project-scoped memories are returned separately, bounded by project_limit. Total response may contain up to limit + project_limit memories.",
          ),
        project_limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe(
            "Max project-scoped (global) memories to always include (default 50)",
          ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.sessionStart(
          params.workspace_id,
          params.user_id,
          params.context,
          params.limit,
          params.project_limit,
        );
        return toolResponse(result);
      });
    },
  );
}
