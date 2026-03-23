// INFR-03: Embedding provider interface -- swappable via environment variable
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  readonly modelName: string;
  readonly dimensions: number;
}
