import { Router } from "express";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import type { RelationshipService } from "../services/relationship-service.js";
import { config } from "../config.js";
import { DomainError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { parseCursor } from "../utils/validation.js";
import { toolSchemas, type ToolName } from "./api-schemas.js";

export function createApiToolsRouter(
  memoryService: MemoryService,
  relationshipService: RelationshipService,
): Router {
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
            b.workspace_id,
            b.user_id,
            b.context,
            b.limit,
            b.project_limit,
          );
          res.json(result);
          break;
        }

        case "memory_create": {
          const b = body as z.infer<typeof toolSchemas.memory_create>;
          const result = await memoryService.create({
            workspace_id: b.workspace_id,
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
          const result = await memoryService.getMany(
            b.ids,
            b.user_id,
            b.include,
          );
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
            b.workspace_id,
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
            project_id: config.projectId,
            workspace_id: b.workspace_id,
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
            b.workspace_id,
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
            b.workspace_id,
            b.user_id,
            new Date(b.since),
            b.limit,
            b.exclude_self,
          );
          res.json(result);
          break;
        }

        case "memory_relate": {
          const b = body as z.infer<typeof toolSchemas.memory_relate>;
          const result = await relationshipService.create({
            sourceId: b.source_id,
            targetId: b.target_id,
            type: b.type,
            description: b.description,
            confidence: b.confidence,
            userId: b.user_id,
            createdVia: b.created_via,
          });
          res.json(result);
          break;
        }

        case "memory_unrelate": {
          const b = body as z.infer<typeof toolSchemas.memory_unrelate>;
          await relationshipService.remove(b.id, b.user_id);
          res.json({ success: true });
          break;
        }

        case "memory_relationships": {
          const b = body as z.infer<typeof toolSchemas.memory_relationships>;
          const relStart = Date.now();
          const { relationships, omitted } =
            await relationshipService.listForMemories(
              b.memory_ids,
              b.direction,
              b.user_id,
              b.type,
            );
          res.json({
            data: relationships,
            meta: {
              count: relationships.length,
              timing: Date.now() - relStart,
              omitted: omitted.length > 0 ? omitted : undefined,
            },
          });
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
