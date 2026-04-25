import { DomainError } from "../utils/errors.js";
import { stripNullsReplacer } from "../utils/json-replacer.js";

/** Wrap a serializable payload as MCP CallToolResult content. Accepts any
 * object, not just Envelope<T> — memory_session_start's wire shape is
 * { preview, full, meta } and is not envelope-shaped. */
export function toolResponse<T>(payload: T): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, stripNullsReplacer) },
    ],
  };
}

/** Wrap a DomainError as MCP error response (isError: true per RESEARCH Pattern 8) */
export function toolError(error: DomainError): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { error: error.message, code: error.code },
          stripNullsReplacer,
        ),
      },
    ],
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
