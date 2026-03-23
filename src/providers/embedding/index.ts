import { config } from "../../config.js";
import type { EmbeddingProvider } from "./types.js";
import { TitanEmbeddingProvider } from "./titan.js";
import { MockEmbeddingProvider } from "./mock.js";

export function createEmbeddingProvider(): EmbeddingProvider {
  switch (config.embeddingProvider) {
    case "titan":
      return new TitanEmbeddingProvider(config.awsRegion, config.embeddingTimeoutMs);
    case "mock":
      return new MockEmbeddingProvider();
    default:
      throw new Error(`Unknown embedding provider: ${config.embeddingProvider}`);
  }
}

export type { EmbeddingProvider } from "./types.js";
export { TitanEmbeddingProvider } from "./titan.js";
export { MockEmbeddingProvider } from "./mock.js";
