import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Environments } from '../../src/environments.js';
import type { Keychain, Runtime } from '../../src/runtime.js';

/** A keychain in memory, by account. */
export function memoryKeychain(): Keychain & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: (account) => entries.get(account) ?? null,
    set: (account, secret) => {
      entries.set(account, secret);
    },
    delete: (account) => entries.delete(account),
  };
}

export interface TestRuntime {
  readonly runtime: Runtime;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Every wait the CLI asked for, in milliseconds; none is waited out. */
  readonly sleeps: number[];
  readonly opened: string[];
  readonly configDir: string;
}

/** A runtime whose dev environment is a fake Agentrail at `mcpUrl`. */
export async function testRuntime(options: {
  mcpUrl: string;
  terminal?: boolean;
  env?: Record<string, string>;
  keychain?: Keychain | undefined;
  cwd?: string;
  now?: () => Date;
}): Promise<TestRuntime> {
  let out = '';
  let err = '';
  const sleeps: number[] = [];
  const opened: string[] = [];
  const configDir = await mkdtemp(join(tmpdir(), 'agentrail-config-'));
  const environments: Environments = {
    prod: {
      name: 'prod',
      mcpUrl: 'https://mcp.example.com/mcp',
      clientId: undefined,
    },
    dev: { name: 'dev', mcpUrl: options.mcpUrl, clientId: 'client_test' },
  };
  const terminal = options.terminal ?? false;
  const runtime: Runtime = {
    env: options.env ?? {},
    environments,
    cwd: options.cwd ?? (await mkdtemp(join(tmpdir(), 'agentrail-cwd-'))),
    configDir,
    stdout: {
      write: (text) => {
        out += text;
      },
      isTTY: terminal,
    },
    stderr: {
      write: (text) => {
        err += text;
      },
      isTTY: terminal,
    },
    stdinIsTTY: terminal,
    fetch: globalThis.fetch,
    keychain: 'keychain' in options ? options.keychain : memoryKeychain(),
    now: options.now ?? (() => new Date()),
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
    openBrowser: (url) => {
      opened.push(url);
    },
  };
  return {
    runtime,
    stdout: () => out,
    stderr: () => err,
    sleeps,
    opened,
    configDir,
  };
}
