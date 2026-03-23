import type { Envelope } from "../types/envelope.js";
import { DomainError } from "../utils/errors.js";

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
