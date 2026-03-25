import { Router } from "express";
import type { MemoryService } from "../services/memory-service.js";

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

    try {
      switch (toolName) {
        case "memory_session_start": {
          const { project_id, user_id, context, limit } = req.body;
          const result = await memoryService.sessionStart(
            project_id,
            user_id,
            context,
            limit ?? 10,
          );
          res.json(result);
          break;
        }
        default:
          res.status(404).json({ error: `Unknown tool: ${toolName}` });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
