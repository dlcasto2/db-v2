/**
 * Shared logger factory — private module (starts with _), not mapped as a route.
 */
export function createLogger(tag: string) {
  return {
    log(...args: unknown[]) {
      console.log(`[${tag}][${new Date().toISOString()}]`, ...args);
    },
    error(...args: unknown[]) {
      console.error(`[${tag}][${new Date().toISOString()}]`, ...args);
    },
  };
}
