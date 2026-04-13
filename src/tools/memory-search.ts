import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import {
  slugSchema,
  userIdSchema,
  memoryScopeEnum,
} from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemorySearch(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_search",
    {
      description:
        'Search memories by semantic similarity across one or more scopes. Returns ranked results with relevance scores. user_id is required for all searches to enforce scope-based access control. Example: memory_search({ workspace_id: "my-project", query: "database migration patterns", user_id: "alice", scope: ["workspace", "user"] })',
      inputSchema: {
        workspace_id: slugSchema.describe(
          "Workspace slug to search within (e.g., 'my-project')",
        ),
        query: z.string().describe("Natural language search query"),
        scope: z
          .array(memoryScopeEnum)
          .min(1)
          .default(["workspace"])
          .describe(
            'Scopes to search, e.g. ["workspace", "user"]. Defaults to ["workspace"]. Project-scoped memories are always included.',
          ),
        user_id: userIdSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Max results to return (default 10)"),
        min_similarity: z
          .number()
          .min(0)
          .max(1)
          .default(0.3)
          .describe("Minimum similarity threshold (default 0.3)"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.search(
          params.query,
          params.workspace_id,
          params.scope,
          params.user_id,
          params.limit,
          params.min_similarity,
        );
        return toolResponse(result);
      });
    },
  );
}
