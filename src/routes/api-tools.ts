import { Router } from "express";
import type { MemoryService } from "../services/memory-service.js";
import { DomainError } from "../utils/errors.js";

function parseCursor(
  cursor: string | undefined,
): { created_at: string; id: string } | undefined {
  if (!cursor) return undefined;
  const sep = cursor.indexOf("|");
  if (sep === -1) return undefined;
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
    const body = req.body;

    try {
      switch (toolName) {
        case "memory_session_start": {
          const result = await memoryService.sessionStart(
            body.project_id,
            body.user_id,
            body.context,
            body.limit ?? 10,
          );
          res.json(result);
          break;
        }

        case "memory_create": {
          const result = await memoryService.create({
            project_id: body.project_id,
            content: body.content,
            title: body.title,
            type: body.type,
            tags: body.tags,
            scope: body.scope,
            author: body.user_id,
            source: body.source,
            session_id: body.session_id,
            metadata: body.metadata,
          });
          res.json(result);
          break;
        }

        case "memory_get": {
          const result = await memoryService.getWithComments(
            body.id,
            body.user_id,
          );
          res.json(result);
          break;
        }

        case "memory_update": {
          const { id, version, user_id, ...updates } = body;
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
          const result = await memoryService.archive(body.ids, body.user_id);
          res.json(result);
          break;
        }

        case "memory_search": {
          const result = await memoryService.search(
            body.query,
            body.project_id,
            body.scope ?? "project",
            body.user_id,
            body.limit ?? 10,
            body.min_similarity ?? 0.3,
          );
          res.json(result);
          break;
        }

        case "memory_list": {
          const result = await memoryService.list({
            project_id: body.project_id,
            scope: body.scope ?? "project",
            user_id: body.user_id,
            type: body.type,
            tags: body.tags,
            sort_by: body.sort_by ?? "created_at",
            order: body.order ?? "desc",
            cursor: parseCursor(body.cursor),
            limit: body.limit ?? 20,
          });
          res.json(result);
          break;
        }

        case "memory_verify": {
          const result = await memoryService.verify(body.id, body.user_id);
          res.json(result);
          break;
        }

        case "memory_list_stale": {
          const result = await memoryService.listStale(
            body.project_id,
            body.user_id,
            body.threshold_days ?? 30,
            body.limit ?? 20,
            parseCursor(body.cursor),
          );
          res.json(result);
          break;
        }

        case "memory_comment": {
          const result = await memoryService.addComment(
            body.memory_id,
            body.user_id,
            body.content,
          );
          res.json(result);
          break;
        }

        case "memory_list_recent": {
          const result = await memoryService.listRecentActivity(
            body.project_id,
            body.user_id,
            new Date(body.since),
            body.limit ?? 10,
            body.exclude_self ?? false,
          );
          res.json(result);
          break;
        }

        default:
          res.status(404).json({ error: `Unknown tool: ${toolName}` });
      }
    } catch (err) {
      if (err instanceof DomainError) {
        res
          .status(err.statusHint ?? 500)
          .json({ error: err.message, code: err.code });
        return;
      }
      const message =
        err instanceof Error ? err.message : "Internal server error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
