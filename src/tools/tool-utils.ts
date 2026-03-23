import type { Envelope } from "../types/envelope.js";
import { DomainError, ValidationError } from "../utils/errors.js";

const VALID_MEMORY_TYPES = ["fact", "decision", "learning", "pattern", "preference", "architecture"] as const;
export type ValidMemoryType = (typeof VALID_MEMORY_TYPES)[number];

/** Validate and coerce a memory type string. MCP clients (e.g. Inspector) may send empty strings. */
export function validateMemoryType(value: string): ValidMemoryType {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError("type is required");
  if (!VALID_MEMORY_TYPES.includes(trimmed as ValidMemoryType)) {
    throw new ValidationError(`Invalid type: '${trimmed}'. Must be one of: ${VALID_MEMORY_TYPES.join(", ")}`);
  }
  return trimmed as ValidMemoryType;
}

/** Wrap an Envelope as MCP CallToolResult content */
export function toolResponse<T>(envelope: Envelope<T>): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
  };
}

/** Wrap a DomainError as MCP error response (isError: true per RESEARCH Pattern 8) */
export function toolError(error: DomainError): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: error.message, code: error.code }) }],
    isError: true,
  };
}

/** Wrap tool handler with error handling -- catches DomainError and returns isError, rethrows others */
export function withErrorHandling(
  handler: () => Promise<{ content: { type: "text"; text: string }[] }>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  return handler().catch((err) => {
    if (err instanceof DomainError) {
      return toolError(err);
    }
    throw err; // Let MCP SDK handle protocol errors
  });
}
