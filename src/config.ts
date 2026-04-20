import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  projectId: z.string().default(""),
  databaseUrl: z
    .string()
    .default("postgresql://agentic:agentic@localhost:5432/agent_brain"),
  embeddingProvider: z.enum(["titan", "mock", "ollama"]).default("mock"),
  embeddingDimensions: z.coerce.number().int().positive().default(768),
  ollamaBaseUrl: z.string().default("http://localhost:11434"),
  ollamaModel: z.string().default("nomic-embed-text"),
  awsRegion: z.string().default("us-east-1"),
  embeddingTimeoutMs: z.coerce.number().int().positive().default(10000),
  recencyHalfLifeDays: z.coerce.number().positive().default(14),
  writeBudgetPerSession: z.coerce.number().int().nonnegative().default(10),
  duplicateThreshold: z.coerce.number().min(0).max(1).default(0.9),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().max(65535).default(19898),
  version: z.string().default("0.1.0"),
  consolidationEnabled: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  consolidationCron: z.string().default("0 3 * * *"),
  consolidationAutoArchiveThreshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.95),
  consolidationFlagThreshold: z.coerce.number().min(0).max(1).default(0.9),
  consolidationVerifyAfterDays: z.coerce.number().int().positive().default(30),
  consolidationMaxFlagsPerSession: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(5),
  consolidationCatchupEnabled: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  consolidationCatchupGraceSeconds: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(86_400)
    .default(60),
});

export const config = configSchema.parse({
  projectId: process.env.PROJECT_ID ?? "",
  databaseUrl: process.env.DATABASE_URL,
  embeddingProvider: process.env.EMBEDDING_PROVIDER,
  embeddingDimensions: process.env.EMBEDDING_DIMENSIONS,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
  ollamaModel: process.env.OLLAMA_MODEL,
  awsRegion: process.env.AWS_REGION,
  embeddingTimeoutMs: process.env.EMBEDDING_TIMEOUT_MS,
  recencyHalfLifeDays: process.env.RECENCY_HALF_LIFE_DAYS,
  writeBudgetPerSession: process.env.WRITE_BUDGET_PER_SESSION,
  duplicateThreshold: process.env.DUPLICATE_THRESHOLD,
  host: process.env.HOST,
  port: process.env.PORT,
  version: "0.1.0",
  consolidationEnabled: process.env.CONSOLIDATION_ENABLED,
  consolidationCron: process.env.CONSOLIDATION_CRON,
  consolidationAutoArchiveThreshold:
    process.env.CONSOLIDATION_AUTO_ARCHIVE_THRESHOLD,
  consolidationFlagThreshold: process.env.CONSOLIDATION_FLAG_THRESHOLD,
  consolidationVerifyAfterDays: process.env.CONSOLIDATION_VERIFY_AFTER_DAYS,
  consolidationMaxFlagsPerSession:
    process.env.CONSOLIDATION_MAX_FLAGS_PER_SESSION,
  consolidationCatchupEnabled: process.env.CONSOLIDATION_CATCHUP_ENABLED,
  consolidationCatchupGraceSeconds:
    process.env.CONSOLIDATION_CATCHUP_GRACE_SECONDS,
});
