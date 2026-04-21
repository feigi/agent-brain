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
        'Save a new memory to the knowledge base. user_id is required for all operations and enforces scope-based access control. Include session_id from memory_session_start for budget tracking (optional). Example: memory_create({ workspace_id: "my-project", content: "Always run migrations before deploying", type: "decision", user_id: "alice" })',
      inputSchema: {
        workspace_id: slugSchema
          .optional()
          .describe(
            "Workspace slug (e.g., 'my-project'). Required for workspace/user scope. Optional for project scope (cross-workspace).",
          ),
        content: contentSchema.describe(
          "Memory content text. Must not be empty. Soft limit ~4000 chars.",
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
            "'workspace' scopes to this workspace (shared with team), 'user' is private to you, 'project' is visible across all workspaces (set user_confirmed_project_scope:true after asking the user)",
          ),
        user_confirmed_project_scope: z
          .boolean()
          .optional()
          .describe(
            "Set true after the user has explicitly confirmed cross-workspace (project) scope. Required alongside scope:'project' when source is 'agent-auto' or 'session-review'.",
          ),
        user_id: userIdSchema,
        source: memorySourceEnum
          .optional()
          .describe(
            "Origin of the save. Choose exactly one: 'manual' = user explicitly asked you to save (e.g. 'remember X', 'save that'); bypasses budget and project-scope guards. 'agent-auto' = autonomous save during a live conversation; use this as the default for agent-initiated captures. 'session-review' = ONLY for autonomous saves triggered by the end-of-session Stop-hook review; do not use mid-session.",
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
