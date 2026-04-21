import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import {
  slugSchema,
  userIdSchema,
  contentSchema,
  memoryTypeEnum,
  memoryScopeEnum,
  memorySourceEnum,
} from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryCreate(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_create",
    {
      description:
        'Save new memory. user_id required — enforces scope-based access control. Pass session_id from memory_session_start for budget tracking (optional). Example: memory_create({ workspace_id: "my-project", content: "Always run migrations before deploying", type: "decision", user_id: "alice" })',
      inputSchema: {
        workspace_id: slugSchema
          .optional()
          .describe(
            "Workspace slug (e.g., 'my-project'). Required for workspace/user scope. Optional for project scope (cross-workspace).",
          ),
        content: contentSchema.describe(
          "Memory content. Non-empty. Soft limit ~4000 chars.",
        ),
        title: z
          .string()
          .optional()
          .describe("Optional title. Auto-generated from content if omitted."),
        type: memoryTypeEnum.describe("Memory category type"),
        tags: z
          .array(z.string())
          .optional()
          .catch(undefined)
          .describe("Free-form categorization tags"),
        scope: memoryScopeEnum
          .catch("workspace")
          .describe(
            "'workspace' = shared with team in this workspace, 'user' = private to you, 'project' = visible across all workspaces (set user_confirmed_project_scope:true after asking user)",
          ),
        user_confirmed_project_scope: z
          .boolean()
          .optional()
          .describe(
            "Set true after user explicitly confirmed cross-workspace (project) scope. Required with scope:'project' when source is 'agent-auto' or 'session-review'.",
          ),
        user_id: userIdSchema,
        source: memorySourceEnum
          .optional()
          .describe(
            "Origin of save. Pick one: 'manual' = user explicitly asked to save (e.g. 'remember X', 'save that'); bypasses budget + project-scope guards. 'agent-auto' = autonomous save mid-conversation; default for agent-initiated captures. 'session-review' = ONLY for autonomous saves from end-of-session Stop-hook review; never mid-session, never because user asked.",
          ),
        session_id: z
          .string()
          .optional()
          .describe("Agent session ID to group related memories"),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Extensible key-value data (file paths, URLs, etc.)"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.create({
          workspace_id: params.workspace_id,
          content: params.content,
          title: params.title,
          type: params.type,
          tags: params.tags,
          scope: params.scope,
          author: params.user_id,
          source: params.source,
          session_id: params.session_id,
          metadata: params.metadata,
          user_confirmed_project_scope: params.user_confirmed_project_scope,
        });
        return toolResponse(result);
      });
    },
  );
}
