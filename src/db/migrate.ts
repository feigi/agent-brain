import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./index.js";
import { logger } from "../utils/logger.js";

export async function runMigrations(db: Database): Promise<void> {
  logger.info("Running database migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  logger.info("Migrations complete");
}
