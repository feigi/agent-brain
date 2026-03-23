import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createEmbeddingProvider } from "./providers/embedding/index.js";
import { DrizzleMemoryRepository } from "./repositories/memory-repository.js";
import { DrizzleProjectRepository } from "./repositories/project-repository.js";
import { DrizzleCommentRepository } from "./repositories/comment-repository.js";
import { DrizzleSessionTrackingRepository } from "./repositories/session-repository.js";
import { MemoryService } from "./services/memory-service.js";
import { registerAllTools } from "./tools/index.js";
import { logger } from "./utils/logger.js";

async function main() {
  logger.info(`v${config.version} starting...`);

  // Initialize database (D-35)
  const db = createDb(config.databaseUrl);

  // Auto-migrate on startup (D-53)
  await runMigrations(db);
  logger.info("Database connected, migrations applied");

  // Initialize embedding provider
  const embedder = createEmbeddingProvider();
  logger.info(`Embedding provider: ${embedder.modelName} (${embedder.dimensions}d)`);

  // Initialize repositories and service
  const memoryRepo = new DrizzleMemoryRepository(db);
  const projectRepo = new DrizzleProjectRepository(db);
  const commentRepo = new DrizzleCommentRepository(db);
  const sessionRepo = new DrizzleSessionTrackingRepository(db);
  const memoryService = new MemoryService(memoryRepo, projectRepo, embedder, commentRepo, sessionRepo);

  // Create MCP server
  const server = new McpServer({
    name: "agentic-brain",
    version: config.version,
  });

  // Register all 11 tools (D-01)
  registerAllTools(server, memoryService);

  // Connect stdio transport (D-49)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Startup banner to stderr (D-52)
  logger.info("Server ready on stdio");

  // Graceful shutdown (D-51)
  const shutdown = async () => {
    logger.info("Shutting down...");
    await server.close();
    await db.$client.end(); // postgres.js connection cleanup (Pitfall 8)
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
