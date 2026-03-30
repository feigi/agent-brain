import type { EmbeddingProvider } from "./types.js";

// D-55: Deterministic mock embedding for dev/test
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelName = "mock-deterministic";

  constructor(private readonly dims: number = 768) {}

  get dimensions(): number {
    return this.dims;
  }

  async embed(text: string): Promise<number[]> {
    // Generate a deterministic hash from the input text
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    // Produce a deterministic vector using sine of hash
    const vector = Array.from({ length: this.dims }, (_, i) => {
      const val = Math.sin(hash * (i + 1) * 0.001);
      return Number(val.toFixed(6));
    });

    return vector;
  }
}
