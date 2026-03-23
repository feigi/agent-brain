import "dotenv/config";

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://agentic:agentic@localhost:5432/agentic_brain",
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "mock") as "titan" | "mock",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  embeddingTimeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? "10000"),
  recencyHalfLifeDays: Number(process.env.RECENCY_HALF_LIFE_DAYS ?? "14"),
  version: "0.1.0",
} as const;
