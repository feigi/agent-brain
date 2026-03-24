import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    onnotice: () => {}, // Suppress PG NOTICE from stdout — corrupts MCP stdio framing
  });
  return drizzle(client, { schema });
}
