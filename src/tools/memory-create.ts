import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema, contentSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryCreate(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_create",
    {
      description:
        'Save a new memory to the knowledge base. user_id is required for all operations and enforces scope-based access control. Autonomous writes (source \'agent-auto\' or \'session-review\') require session_id from memory_session_start. Example: memory_create({ project_id: "my-project", content: "Always run migrations before deploying", type: "decision", user_id: "alice" })',
      inputSchema: {
        project_id: slugSchema.describe("Project slug (e.g., 'my-project'). Required -- no default project."),
        content: contentSchema.describe("Memory content text. Must not be empty. Soft limit ~4000 chars."),
        title: z.string().optional().describe("Optional title. Auto-generated from content if omitted."),
        type: z
          .enum(["fact", "decision", "learning", "pattern", "preference", "architecture"])
          .describe("Memory category type"),
        tags: z.array(z.string()).optional().catch(undefined).describe("Free-form categorization tags"),
        scope: z.enum(["project", "user"]).catch("project").describe("'project' scopes to this project (shared with team), 'user' is private to you"),
        user_id: slugSchema.describe("Who is creating this memory (e.g., 'alice'). Required for provenance and access control."),
        source: z.string().optional().describe("Origin: 'manual', 'agent-auto', 'session-review', or custom"),
        session_id: z.string().optional().describe("Agent session ID to group related memories"),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Extensible key-value data (file paths, URLs, etc.)"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.create({
          project_id: params.project_id,
          content: params.content,
          title: params.title,
          type: params.type,
          tags: params.tags,
          scope: params.scope,
          author: params.user_id,
          source: params.source,
          session_id: params.session_id,
          metadata: params.metadata,
        });
        return toolResponse(result);
      });
    },
  );
}
