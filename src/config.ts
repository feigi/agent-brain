import "dotenv/config";

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://agentic:agentic@localhost:5432/agentic_brain",
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "mock") as
    | "titan"
    | "mock"
    | "ollama",
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? "512"),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "nomic-embed-text",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  embeddingTimeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? "10000"),
  recencyHalfLifeDays: Number(process.env.RECENCY_HALF_LIFE_DAYS ?? "14"),
  writeBudgetPerSession: Number(process.env.WRITE_BUDGET_PER_SESSION ?? "10"),
  duplicateThreshold: Number(process.env.DUPLICATE_THRESHOLD ?? "0.90"),
  version: "0.1.0",
} as const;
