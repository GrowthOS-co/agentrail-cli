import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Environments } from '../../src/environments.js';
import type { Executed, Keychain, Runtime } from '../../src/runtime.js';

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

/**
 * A keychain that cannot be used, as on a system without one or with one
 * locked: every call throws, as the real one does.
 */
export function lockedKeychain(): Keychain {
  const refuse = (): never => {
    throw new Error('Platform secure storage failure: no keychain');
  };
  return { get: refuse, set: refuse, delete: refuse };
}

export interface TestRuntime {
  readonly runtime: Runtime;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Every wait the CLI asked for, in milliseconds; none is waited out. */
  readonly sleeps: number[];
  readonly opened: string[];
  readonly configDir: string;
  /** Every program the CLI ran, with its arguments. */
  readonly executed: string[][];
}

/** A runtime whose dev environment is a fake Agentrail at `mcpUrl`. */
export async function testRuntime(options: {
  mcpUrl: string;
  terminal?: boolean;
  env?: Record<string, string>;
  keychain?: Keychain;
  cwd?: string;
  homeDir?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  /** Runs at each wait the CLI asks for, as if that long had passed. */
  onSleep?: () => void;
  /** Programs on the PATH, and how each call to one ends. */
  commands?: Readonly<Record<string, (args: readonly string[]) => Executed>>;
}): Promise<TestRuntime> {
  let out = '';
  let err = '';
  const sleeps: number[] = [];
  const opened: string[] = [];
  const executed: string[][] = [];
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
    // No test asks the real npm registry unless it turns the check back on.
    env: { AGENTRAIL_NO_UPDATE_CHECK: '1', ...options.env },
    environments,
    cwd: options.cwd ?? (await mkdtemp(join(tmpdir(), 'agentrail-cwd-'))),
    configDir,
    homeDir:
      options.homeDir ?? (await mkdtemp(join(tmpdir(), 'agentrail-home-'))),
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
    fetch: options.fetch ?? globalThis.fetch,
    keychain: options.keychain ?? memoryKeychain(),
    now: options.now ?? (() => new Date()),
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      options.onSleep?.();
      return Promise.resolve();
    },
    openBrowser: (url) => {
      opened.push(url);
    },
    hasCommand: (name) =>
      Promise.resolve(options.commands?.[name] !== undefined),
    exec: (command, args) => {
      executed.push([command, ...args]);
      const program = options.commands?.[command];
      if (!program) throw new Error(`test ran ${command}, which is not set up`);
      return Promise.resolve(program(args));
    },
  };
  return {
    runtime,
    stdout: () => out,
    stderr: () => err,
    sleeps,
    opened,
    configDir,
    executed,
  };
}
