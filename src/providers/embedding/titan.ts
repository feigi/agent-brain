import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { EmbeddingProvider } from "./types.js";
import { EmbeddingError, ValidationError } from "../../utils/errors.js";

const VALID_DIMENSIONS = [256, 512, 1024] as const;

const MAX_INPUT_CHARS = 32_000; // Safety margin for ~8192 token limit

export class TitanEmbeddingProvider implements EmbeddingProvider {
  readonly modelName = "amazon.titan-embed-text-v2:0";
  private readonly client: BedrockRuntimeClient;

  constructor(
    region = "us-east-1",
    timeoutMs = 10_000,
    private readonly dims = 512,
  ) {
    if (!VALID_DIMENSIONS.includes(dims as (typeof VALID_DIMENSIONS)[number])) {
      throw new ValidationError(
        `Titan V2 supports dimensions ${VALID_DIMENSIONS.join(", ")} — got ${dims}. Set EMBEDDING_DIMENSIONS to a valid value.`,
      );
    }

    this.client = new BedrockRuntimeClient({
      region,
      requestHandler: { requestTimeout: timeoutMs },
    });
  }

  get dimensions(): number {
    return this.dims;
  }

  async embed(text: string): Promise<number[]> {
    const inputText =
      text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: this.modelName,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            inputText,
            dimensions: this.dims,
            normalize: true,
          }),
        }),
      );

      const body = JSON.parse(new TextDecoder().decode(response.body));
      return body.embedding as number[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingError(`Titan embedding failed: ${message}`);
    }
  }
}
