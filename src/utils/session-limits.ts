// Centralized bounds for memory_session_start limit parameters.
// Referenced by Zod schemas (MCP tool + HTTP route) and the service default
// so the three sites cannot drift.

import { z } from "zod";

export const PROJECT_LIMIT_MIN = 1;
export const PROJECT_LIMIT_MAX = 200;
export const PROJECT_LIMIT_DEFAULT = 50;

export const projectLimitSchema = z
  .number()
  .int()
  .min(PROJECT_LIMIT_MIN)
  .max(PROJECT_LIMIT_MAX)
  .default(PROJECT_LIMIT_DEFAULT);
