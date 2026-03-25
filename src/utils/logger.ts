export const logger = {
  info: (...args: unknown[]) => console.error("[agent-brain]", ...args),
  warn: (...args: unknown[]) => console.error("[agent-brain] WARN:", ...args),
  error: (...args: unknown[]) => console.error("[agent-brain] ERROR:", ...args),
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.error("[agent-brain] DEBUG:", ...args);
  },
};
