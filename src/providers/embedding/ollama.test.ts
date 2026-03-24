import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaEmbeddingProvider } from "./ollama.js";
import { MockEmbeddingProvider } from "./mock.js";
import { EmbeddingError } from "../../utils/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OllamaEmbeddingProvider", () => {
  it("reports correct modelName", () => {
    const provider = new OllamaEmbeddingProvider("http://localhost:11434", "nomic-embed-text", 768);
    expect(provider.modelName).toBe("ollama:nomic-embed-text");
  });

  it("reports correct dimensions from constructor", () => {
    const provider = new OllamaEmbeddingProvider("http://localhost:11434", "nomic-embed-text", 768);
    expect(provider.dimensions).toBe(768);
  });

  it("calls correct URL and returns embedding from response", async () => {
    const expectedEmbedding = Array(768).fill(0.1);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embedding: expectedEmbedding }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = new OllamaEmbeddingProvider("http://localhost:11434", "nomic-embed-text", 768);
    const result = await provider.embed("test text");

    expect(result).toEqual(expectedEmbedding);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/embeddings",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "test text" }),
      },
    );
  });

  it("throws EmbeddingError when dimension mismatch", async () => {
    const wrongSizeEmbedding = Array(512).fill(0.1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embedding: wrongSizeEmbedding }),
    }));

    const provider = new OllamaEmbeddingProvider("http://localhost:11434", "nomic-embed-text", 768);
    await expect(provider.embed("test")).rejects.toThrow(EmbeddingError);
    await expect(provider.embed("test")).rejects.toThrow(
      "Ollama model nomic-embed-text returned 512d vector, expected 768d. Set EMBEDDING_DIMENSIONS=512 to match.",
    );
  });

  it("throws EmbeddingError with connection hint on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new TypeError("fetch failed"),
    ));

    const provider = new OllamaEmbeddingProvider("http://localhost:11434", "nomic-embed-text", 768);
    await expect(provider.embed("test")).rejects.toThrow(EmbeddingError);
    await expect(provider.embed("test")).rejects.toThrow(
      "is Ollama running at http://localhost:11434?",
    );
  });
});

describe("MockEmbeddingProvider with configurable dimensions", () => {
  it("respects custom dimensions", async () => {
    const provider = new MockEmbeddingProvider(768);
    expect(provider.dimensions).toBe(768);
    const result = await provider.embed("test");
    expect(result).toHaveLength(768);
  });

  it("defaults to 512 dimensions", async () => {
    const provider = new MockEmbeddingProvider();
    expect(provider.dimensions).toBe(512);
    const result = await provider.embed("test");
    expect(result).toHaveLength(512);
  });
});
