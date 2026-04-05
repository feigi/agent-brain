import "dotenv/config";

export const config = {
  projectId: process.env.PROJECT_ID ?? "",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://agentic:agentic@localhost:5432/agent_brain",
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "mock") as
    | "titan"
    | "mock"
    | "ollama",
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? "768"),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "nomic-embed-text",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  embeddingTimeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? "10000"),
  recencyHalfLifeDays: Number(process.env.RECENCY_HALF_LIFE_DAYS ?? "14"),
  writeBudgetPerSession: Number(process.env.WRITE_BUDGET_PER_SESSION ?? "10"),
  duplicateThreshold: Number(process.env.DUPLICATE_THRESHOLD ?? "0.90"),
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? "19898"),
  version: "0.1.0",
  consolidationEnabled:
    (process.env.CONSOLIDATION_ENABLED ?? "false") === "true",
  consolidationCron: process.env.CONSOLIDATION_CRON ?? "0 3 * * *",
  consolidationAutoArchiveThreshold: Number(
    process.env.CONSOLIDATION_AUTO_ARCHIVE_THRESHOLD ?? "0.95",
  ),
  consolidationFlagThreshold: Number(
    process.env.CONSOLIDATION_FLAG_THRESHOLD ?? "0.90",
  ),
  consolidationContradictionThreshold: Number(
    process.env.CONSOLIDATION_CONTRADICTION_THRESHOLD ?? "0.80",
  ),
  consolidationVerifyAfterDays: Number(
    process.env.CONSOLIDATION_VERIFY_AFTER_DAYS ?? "30",
  ),
  consolidationMaxFlagsPerSession: Number(
    process.env.CONSOLIDATION_MAX_FLAGS_PER_SESSION ?? "5",
  ),
} as const;
