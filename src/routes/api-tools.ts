import { Router } from "express";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { DomainError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { toolSchemas, type ToolName } from "./api-schemas.js";

function parseCursor(
  cursor: string | undefined,
): { created_at: string; id: string } | undefined {
  if (!cursor) return undefined;
  const sep = cursor.indexOf("|");
  if (sep === -1) {
    throw new ValidationError(
      'Invalid cursor format: expected "created_at|id"',
    );
  }
  return {
    created_at: cursor.slice(0, sep),
    id: cursor.slice(sep + 1),
  };
}

export function createApiToolsRouter(memoryService: MemoryService): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (req.is("json")) {
      next();
    } else {
      res.status(415).json({ error: "Content-Type must be application/json" });
    }
  });

  router.post("/api/tools/:toolName", async (req, res) => {
    const { toolName } = req.params;

    const schema = toolSchemas[toolName as ToolName];
    if (!schema) {
      res.status(404).json({ error: `Unknown tool: ${toolName}` });
      return;
    }

    try {
      const body = schema.parse(req.body);

      switch (toolName) {
        case "memory_session_start": {
          const b = body as z.infer<typeof toolSchemas.memory_session_start>;
          const result = await memoryService.sessionStart(
            b.project_id,
            b.user_id,
            b.context,
            b.limit,
          );
          res.json(result);
          break;
        }

        case "memory_create": {
          const b = body as z.infer<typeof toolSchemas.memory_create>;
          const result = await memoryService.create({
            project_id: b.project_id,
            content: b.content,
            title: b.title,
            type: b.type,
            tags: b.tags,
            scope: b.scope,
            author: b.user_id,
            source: b.source,
            session_id: b.session_id,
            metadata: b.metadata,
          });
          res.json(result);
          break;
        }

        case "memory_get": {
          const b = body as z.infer<typeof toolSchemas.memory_get>;
          const result = await memoryService.getWithComments(b.id, b.user_id);
          res.json(result);
          break;
        }

        case "memory_update": {
          const b = body as z.infer<typeof toolSchemas.memory_update>;
          const { id, version, user_id, ...updates } = b;
          const result = await memoryService.update(
            id,
            version,
            updates,
            user_id,
          );
          res.json(result);
          break;
        }

        case "memory_archive": {
          const b = body as z.infer<typeof toolSchemas.memory_archive>;
          const result = await memoryService.archive(b.ids, b.user_id);
          res.json(result);
          break;
        }

        case "memory_search": {
          const b = body as z.infer<typeof toolSchemas.memory_search>;
          const result = await memoryService.search(
            b.query,
            b.project_id,
            b.scope,
            b.user_id,
            b.limit,
            b.min_similarity,
          );
          res.json(result);
          break;
        }

        case "memory_list": {
          const b = body as z.infer<typeof toolSchemas.memory_list>;
          const result = await memoryService.list({
            project_id: b.project_id,
            scope: b.scope,
            user_id: b.user_id,
            type: b.type,
            tags: b.tags,
            sort_by: b.sort_by,
            order: b.order,
            cursor: parseCursor(b.cursor),
            limit: b.limit,
          });
          res.json(result);
          break;
        }

        case "memory_verify": {
          const b = body as z.infer<typeof toolSchemas.memory_verify>;
          const result = await memoryService.verify(b.id, b.user_id);
          res.json(result);
          break;
        }

        case "memory_list_stale": {
          const b = body as z.infer<typeof toolSchemas.memory_list_stale>;
          const result = await memoryService.listStale(
            b.project_id,
            b.user_id,
            b.threshold_days,
            b.limit,
            parseCursor(b.cursor),
          );
          res.json(result);
          break;
        }

        case "memory_comment": {
          const b = body as z.infer<typeof toolSchemas.memory_comment>;
          const result = await memoryService.addComment(
            b.memory_id,
            b.user_id,
            b.content,
          );
          res.json(result);
          break;
        }

        case "memory_list_recent": {
          const b = body as z.infer<typeof toolSchemas.memory_list_recent>;
          const result = await memoryService.listRecentActivity(
            b.project_id,
            b.user_id,
            new Date(b.since),
            b.limit,
            b.exclude_self,
          );
          res.json(result);
          break;
        }
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        res
          .status(400)
          .json({ error: "Validation failed", details: err.issues });
        return;
      }
      if (err instanceof DomainError) {
        logger.warn(`DomainError [${err.code}] on ${toolName}:`, err.message);
        res
          .status(err.statusHint ?? 500)
          .json({ error: err.message, code: err.code });
        return;
      }
      logger.error(`Unhandled error in tool route [${toolName}]:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
