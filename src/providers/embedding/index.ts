import { config } from "../../config.js";
import type { EmbeddingProvider } from "./types.js";
import { TitanEmbeddingProvider } from "./titan.js";
import { MockEmbeddingProvider } from "./mock.js";
import { OllamaEmbeddingProvider } from "./ollama.js";

export function createEmbeddingProvider(): EmbeddingProvider {
  switch (config.embeddingProvider) {
    case "titan":
      return new TitanEmbeddingProvider(
        config.awsRegion,
        config.embeddingTimeoutMs,
        config.embeddingDimensions,
      );
    case "mock":
      return new MockEmbeddingProvider(config.embeddingDimensions);
    case "ollama":
      return new OllamaEmbeddingProvider(
        config.ollamaBaseUrl,
        config.ollamaModel,
        config.embeddingDimensions,
      );
    default:
      throw new Error(
        `Unknown embedding provider: ${config.embeddingProvider}`,
      );
  }
}

export type { EmbeddingProvider } from "./types.js";
export { TitanEmbeddingProvider } from "./titan.js";
export { MockEmbeddingProvider } from "./mock.js";
export { OllamaEmbeddingProvider } from "./ollama.js";
