import { spawn } from "child_process";
import postgres from "postgres";

const TEST_DB = "agent_brain_test";
const MAINTENANCE_URL = "postgresql://agentic:agentic@localhost:5432/postgres";
export const TEST_DB_URL = `postgresql://agentic:agentic@localhost:5432/${TEST_DB}`;

export async function setup() {
  // Ensure Postgres container is running
  await runCommand("docker", ["compose", "up", "-d", "--wait"]).catch(() => {
    console.error(
      "docker compose up failed (port may be in use) -- assuming DB is already running",
    );
  });

  // Connect to maintenance DB to create the test database
  const sql = postgres(MAINTENANCE_URL, { max: 1 });
  try {
    // Terminate any lingering connections to the test DB
    await sql`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${TEST_DB} AND pid <> pg_backend_pid()
    `;
    await sql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await sql.unsafe(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await sql.end();
  }

  // Enable vector extension in the test DB
  const testSql = postgres(TEST_DB_URL, { max: 1 });
  try {
    await testSql`CREATE EXTENSION IF NOT EXISTS vector`;
  } finally {
    await testSql.end();
  }

  // Run migrations against the test DB
  await runCommand("npx", ["drizzle-kit", "migrate"], {
    DATABASE_URL: TEST_DB_URL,
  });
}

export async function teardown() {
  // Connect to maintenance DB to drop the test database
  const sql = postgres(MAINTENANCE_URL, { max: 1 });
  try {
    await sql`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${TEST_DB} AND pid <> pg_backend_pid()
    `;
    await sql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
  } finally {
    await sql.end();
  }
}

function runCommand(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}
