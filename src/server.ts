import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { config } from "./config.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createEmbeddingProvider } from "./providers/embedding/index.js";
import { DrizzleMemoryRepository } from "./repositories/memory-repository.js";
import { DrizzleWorkspaceRepository } from "./repositories/workspace-repository.js";
import { DrizzleCommentRepository } from "./repositories/comment-repository.js";
import {
  DrizzleSessionTrackingRepository,
  DrizzleSessionRepository,
} from "./repositories/session-repository.js";
import { DrizzleAuditRepository } from "./repositories/audit-repository.js";
import { DrizzleFlagRepository } from "./repositories/flag-repository.js";
import { MemoryService } from "./services/memory-service.js";
import { AuditService } from "./services/audit-service.js";
import { FlagService } from "./services/flag-service.js";
import { ConsolidationService } from "./services/consolidation-service.js";
import { ConsolidationJob } from "./scheduler/consolidation-job.js";
import { ConsolidationScheduler } from "./scheduler/consolidation-scheduler.js";
import { registerAllTools } from "./tools/index.js";
import { registerMemoryGuidance } from "./prompts/memory-guidance.js";
import { registerRoutes } from "./routes/index.js";
import { logger } from "./utils/logger.js";

async function main() {
  process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled rejection at:", promise, "reason:", reason);
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error);
    process.exit(1);
  });

  logger.info(`v${config.version} starting...`);

  // Initialize database
  const db = createDb(config.databaseUrl);
  try {
    await runMigrations(db);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      err != null && typeof err === "object" && "code" in err
        ? (err as { code: string }).code
        : "";
    const isConnectionError =
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "ECONNRESET" ||
      code.startsWith("08"); // PostgreSQL connection exception class
    if (isConnectionError) {
      logger.error(
        `Database connection failed: ${msg}. Is PostgreSQL running? Try: docker compose up -d`,
      );
    } else {
      logger.error(`Database migration failed: ${msg}`);
    }
    throw err;
  }
  logger.info("Database connected, migrations applied");

  // Initialize embedding provider
  const embedder = createEmbeddingProvider();
  logger.info(
    `Embedding provider: ${embedder.modelName} (${embedder.dimensions}d)`,
  );

  // Validate project ID
  if (!config.projectId) {
    logger.error("PROJECT_ID environment variable is required");
    process.exit(1);
  }
  logger.info(`Project: ${config.projectId}`);

  // Initialize repositories and service
  const memoryRepo = new DrizzleMemoryRepository(db);
  const workspaceRepo = new DrizzleWorkspaceRepository(db);
  const commentRepo = new DrizzleCommentRepository(db);
  const sessionRepo = new DrizzleSessionTrackingRepository(db);
  const sessionLifecycleRepo = new DrizzleSessionRepository(db);
  const auditRepo = new DrizzleAuditRepository(db);
  const auditService = new AuditService(auditRepo, config.projectId);
  const flagRepo = new DrizzleFlagRepository(db);
  const flagService = new FlagService(flagRepo, auditService, config.projectId);
  const memoryService = new MemoryService(
    memoryRepo,
    workspaceRepo,
    embedder,
    config.projectId,
    commentRepo,
    sessionRepo,
    sessionLifecycleRepo,
    auditService,
    flagService,
    config.consolidationMaxFlagsPerSession,
  );

  // Always create ConsolidationService (used by both scheduler and MCP tool)
  const consolidationService = new ConsolidationService(
    memoryRepo,
    flagService,
    auditService,
    config.projectId,
    {
      autoArchiveThreshold: config.consolidationAutoArchiveThreshold,
      flagThreshold: config.consolidationFlagThreshold,
      verifyAfterDays: config.consolidationVerifyAfterDays,
    },
  );

  // Initialize consolidation scheduler (opt-in via config)
  let consolidationScheduler: ConsolidationScheduler | null = null;

  if (config.consolidationEnabled) {
    const consolidationJob = new ConsolidationJob(consolidationService, db);
    consolidationScheduler = new ConsolidationScheduler(
      consolidationJob,
      config.consolidationCron,
    );
    consolidationScheduler.start();
  }

  // Factory: creates a fresh MCP server per session (tools + prompts registered)
  function createMcpServerForSession(): McpServer {
    const server = new McpServer({
      name: "agent-brain",
      version: config.version,
    });
    registerAllTools(server, memoryService, flagService, consolidationService);
    registerMemoryGuidance(server);
    return server;
  }

  // Express app with DNS rebinding protection
  const app = createMcpExpressApp();

  // No auth — return 404 for OAuth discovery so clients don't think auth is required
  app.get("/.well-known/oauth-protected-resource", (_req, res) =>
    res.status(404).end(),
  );
  app.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.status(404).end(),
  );

  // Register REST routes (health + hook API)
  registerRoutes(app, memoryService);

  // MCP Streamable HTTP: POST /mcp (stateless — no session tracking needed)
  app.post("/mcp", async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createMcpServerForSession();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // SSE and session termination not needed in stateless mode
  app.get("/mcp", (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST, DELETE")
      .send("SSE not supported in stateless mode");
  });
  app.delete("/mcp", (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST, DELETE")
      .send("Session termination not needed in stateless mode");
  });

  // Start HTTP server
  app.listen(config.port, config.host, () => {
    logger.info(`Server ready on http://${config.host}:${config.port}/mcp`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    if (consolidationScheduler) {
      await consolidationScheduler.stop();
    }
    await db.$client.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
