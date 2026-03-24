import type { EmbeddingProvider } from "./types.js";
import { EmbeddingError } from "../../utils/errors.js";

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly dims: number,
  ) {}

  get modelName(): string {
    return "ollama:" + this.model;
  }

  get dimensions(): number {
    return this.dims;
  }

  async embed(text: string): Promise<number[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = message.includes("ECONNREFUSED") || message.includes("fetch failed")
        ? ` -- is Ollama running at ${this.baseUrl}?`
        : "";
      throw new EmbeddingError(`Ollama embedding failed: ${message}${hint}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new EmbeddingError(
        `Ollama embedding failed: HTTP ${response.status}${body ? ` - ${body}` : ""}`,
      );
    }

    const data = await response.json();
    const embedding: number[] = data.embedding;

    if (!embedding || embedding.length !== this.dims) {
      const actual = embedding?.length ?? 0;
      throw new EmbeddingError(
        `Ollama model ${this.model} returned ${actual}d vector, expected ${this.dims}d. Set EMBEDDING_DIMENSIONS=${actual} to match.`,
      );
    }

    return embedding;
  }
}
