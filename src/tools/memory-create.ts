import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryCreate(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_create",
    {
      description:
        'Save a new memory to the knowledge base. Example: memory_create({ project_id: "my-project", content: "Always run migrations before deploying", type: "decision", user_id: "alice" })',
      inputSchema: {
        project_id: z.string().describe("Project slug (e.g., 'my-project'). Required -- no default project."),
        content: z.string().describe("Memory content text. Soft limit ~4000 chars."),
        title: z.string().optional().describe("Optional title. Auto-generated from content if omitted."),
        type: z
          .enum(["fact", "decision", "learning", "pattern", "preference", "architecture"])
          .describe("Memory category type"),
        tags: z.array(z.string()).optional().catch(undefined).describe("Free-form categorization tags"),
        scope: z.enum(["project", "user"]).catch("project").describe("'project' scopes to this project, 'user' follows you across projects"),
        user_id: z.string().describe("Who is creating this memory (author for provenance)"),
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
