import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { config } from "../config.js";
import {
  slugSchema,
  userIdSchema,
  memoryTypeEnum,
  memoryScopeEnum,
  parseCursor,
} from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryList(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_list",
    {
      description:
        'Browse memories with filter, sort, pagination. Multi-scope in one call, e.g. scope: ["workspace", "user", "project"]. Scope honored literally — pass "project" explicitly to include cross-workspace (global) memories. Example: memory_list({ workspace_id: "my-project", user_id: "alice", scope: ["workspace", "user"] })',
      inputSchema: {
        workspace_id: slugSchema
          .optional()
          .describe(
            "Workspace slug (e.g., 'my-project'). Required for workspace/user scope. Optional for project scope (cross-workspace).",
          ),
        scope: z
          .array(memoryScopeEnum)
          .min(1)
          .default(["workspace"])
          .describe(
            'Scopes to include, e.g. ["workspace", "user", "project"]. Defaults to ["workspace"]. Honored literally — pass "project" explicitly to include cross-workspace (global) memories.',
          ),
        user_id: userIdSchema,
        type: memoryTypeEnum.optional().describe("Filter by memory type"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Filter by tags (memories matching ANY tag)"),
        sort_by: z
          .enum(["created_at", "updated_at"])
          .default("created_at")
          .describe("Sort field"),
        order: z.enum(["asc", "desc"]).default("desc").describe("Sort order"),
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from previous response"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Max results per page (default 20)"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.list({
          project_id: config.projectId,
          workspace_id: params.workspace_id,
          scope: params.scope,
          user_id: params.user_id,
          type: params.type,
          tags: params.tags,
          sort_by: params.sort_by,
          order: params.order,
          cursor: parseCursor(params.cursor),
          limit: params.limit,
        });
        return toolResponse(result);
      });
    },
  );
}
