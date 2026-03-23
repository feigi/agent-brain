import type { EmbeddingProvider } from "./types.js";

// D-55: Deterministic mock embedding for dev/test
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelName = "mock-deterministic";
  readonly dimensions = 512;

  async embed(text: string): Promise<number[]> {
    // Generate a deterministic hash from the input text
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    // Produce a deterministic 512-element vector using sine of hash
    const vector = Array.from({ length: 512 }, (_, i) => {
      const val = Math.sin(hash * (i + 1) * 0.001);
      return Number(val.toFixed(6));
    });

    return vector;
  }
}
