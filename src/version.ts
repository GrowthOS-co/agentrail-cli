import { createRequire } from 'node:module';

/** The installed package's version, from its own package.json. */
export const VERSION = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
