import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemorySearch(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_search",
    {
      description:
        'Search memories by semantic similarity. Returns ranked results with relevance scores. user_id is required for all searches to enforce scope-based access control. Example: memory_search({ project_id: "my-project", query: "database migration patterns", user_id: "alice" })',
      inputSchema: {
        project_id: slugSchema.describe(
          "Project slug to search within (e.g., 'my-project')",
        ),
        query: z.string().describe("Natural language search query"),
        scope: z
          .enum(["project", "user", "both"])
          .catch("project")
          .describe(
            "Search scope: 'project' (default), 'user' (your memories), or 'both'",
          ),
        user_id: slugSchema.describe(
          "User identifier (e.g., 'alice'). Required for access control and user-scope filtering.",
        ),
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
          params.project_id,
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
