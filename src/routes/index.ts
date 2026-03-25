import type { Express } from "express";
import type { MemoryService } from "../services/memory-service.js";
import { healthRouter } from "./health.js";
import { createApiToolsRouter } from "./api-tools.js";

export function registerRoutes(
  app: Express,
  memoryService: MemoryService,
): void {
  app.use(healthRouter);
  app.use(createApiToolsRouter(memoryService));
}
