// Centralized bounds for memory_session_start limit parameters.
// Referenced by Zod schemas (MCP tool + HTTP route) and the service default
// so the three sites cannot drift.

export const PROJECT_LIMIT_MIN = 1;
export const PROJECT_LIMIT_MAX = 200;
export const PROJECT_LIMIT_DEFAULT = 50;
