import "dotenv/config";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createEmbeddingProvider } from "./providers/embedding/index.js";
import { DrizzleMemoryRepository } from "./repositories/memory-repository.js";
import { DrizzleProjectRepository } from "./repositories/project-repository.js";
import { DrizzleCommentRepository } from "./repositories/comment-repository.js";
import {
  DrizzleSessionTrackingRepository,
  DrizzleSessionRepository,
} from "./repositories/session-repository.js";
import { MemoryService } from "./services/memory-service.js";
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
  await runMigrations(db);
  logger.info("Database connected, migrations applied");

  // Initialize embedding provider
  const embedder = createEmbeddingProvider();
  logger.info(
    `Embedding provider: ${embedder.modelName} (${embedder.dimensions}d)`,
  );

  // Initialize repositories and service
  const memoryRepo = new DrizzleMemoryRepository(db);
  const projectRepo = new DrizzleProjectRepository(db);
  const commentRepo = new DrizzleCommentRepository(db);
  const sessionRepo = new DrizzleSessionTrackingRepository(db);
  const sessionLifecycleRepo = new DrizzleSessionRepository(db);
  const memoryService = new MemoryService(
    memoryRepo,
    projectRepo,
    embedder,
    commentRepo,
    sessionRepo,
    sessionLifecycleRepo,
  );

  // Factory: creates a fresh MCP server per session (tools + prompts registered)
  function createMcpServerForSession(): McpServer {
    const server = new McpServer({
      name: "agent-brain",
      version: config.version,
    });
    registerAllTools(server, memoryService);
    registerMemoryGuidance(server);
    return server;
  }

  // Express app with DNS rebinding protection
  const app = createMcpExpressApp();

  // Register REST routes (health + hook API)
  registerRoutes(app, memoryService);

  // Session transport map
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // MCP Streamable HTTP: POST /mcp
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) delete transports[sid];
        };
        const server = createMcpServerForSession();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID" },
          id: null,
        });
      }
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

  // MCP Streamable HTTP: GET /mcp (SSE stream)
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      logger.error("MCP SSE error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  // MCP Streamable HTTP: DELETE /mcp (session termination)
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      logger.error("MCP session teardown error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  // Start HTTP server
  app.listen(config.port, config.host, () => {
    logger.info(`Server ready on http://${config.host}:${config.port}/mcp`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    for (const sid of Object.keys(transports)) {
      await transports[sid].close();
      delete transports[sid];
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
