export const logger = {
  info: (...args: unknown[]) => console.error("[agentic-brain]", ...args),
  warn: (...args: unknown[]) => console.error("[agentic-brain] WARN:", ...args),
  error: (...args: unknown[]) => console.error("[agentic-brain] ERROR:", ...args),
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.error("[agentic-brain] DEBUG:", ...args);
  },
};
