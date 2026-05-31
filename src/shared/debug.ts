// Lightweight, prefixed logger. Silenced in production builds via esbuild dead-code elimination.
export const DEBUG = process.env.NODE_ENV !== "production";

const PREFIX = "[Glimpse]";

export const log = (...args: unknown[]): void => {
  if (DEBUG) console.log(PREFIX, ...args);
};

export const warn = (...args: unknown[]): void => {
  if (DEBUG) console.warn(PREFIX, ...args);
};

export const errorLog = (...args: unknown[]): void => {
  console.error(PREFIX, ...args);
};
