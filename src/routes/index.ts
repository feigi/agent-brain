import type { Express } from "express";
import type { MemoryService } from "../services/memory-service.js";
import type { RelationshipService } from "../services/relationship-service.js";
import { healthRouter } from "./health.js";
import { createApiToolsRouter } from "./api-tools.js";

export function registerRoutes(
  app: Express,
  memoryService: MemoryService,
  relationshipService: RelationshipService,
): void {
  app.use(healthRouter);
  app.use(createApiToolsRouter(memoryService, relationshipService));
}
