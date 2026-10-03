import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { Entry } from '@napi-rs/keyring';

import { ENVIRONMENTS, type Environments } from './environments.js';

/** The OS keychain, by account name; absent where the platform has none. */
export interface Keychain {
  get(account: string): string | null;
  set(account: string, secret: string): void;
  delete(account: string): boolean;
}

/** What a finished program said and how it ended. */
export interface Executed {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Stream {
  write(text: string): void;
  readonly isTTY: boolean;
}

/**
 * Everything the CLI reads from or does to the world, so a test can hand it
 * a fake one: the process environment, the terminal, the network, the
 * keychain, the clock, the browser.
 */
export interface Runtime {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where each Agentrail environment is. */
  readonly environments: Environments;
  readonly cwd: string;
  /** Where the CLI keeps its own files: pending sign-ins, the catalog cache. */
  readonly configDir: string;
  /** The user's home, where coding agents keep their configuration. */
  readonly homeDir: string;
  readonly stdout: Stream;
  readonly stderr: Stream;
  readonly stdinIsTTY: boolean;
  readonly fetch: typeof fetch;
  readonly keychain: Keychain | undefined;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly openBrowser: (url: string) => void;
  /** Whether a program is on the PATH. */
  readonly hasCommand: (name: string) => Promise<boolean>;
  /** Runs a program directly, without a shell, and waits for it. */
  readonly exec: (
    command: string,
    args: readonly string[],
  ) => Promise<Executed>;
}

const KEYCHAIN_SERVICE = 'agentrail-cli';

function systemKeychain(): Keychain {
  const entry = (account: string) => new Entry(KEYCHAIN_SERVICE, account);
  return {
    get: (account) => entry(account).getPassword(),
    set: (account, secret) => {
      entry(account).setPassword(secret);
    },
    delete: (account) => entry(account).deletePassword(),
  };
}

function configDirOf(env: Readonly<Record<string, string | undefined>>) {
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'agentrail');
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  // Best effort: the URL is printed too, so a missing opener costs nothing.
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

async function onPath(name: string): Promise<boolean> {
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : [''];
  const directories = (process.env.PATH ?? '').split(delimiter);
  for (const directory of directories.filter(Boolean)) {
    for (const extension of extensions) {
      try {
        await access(join(directory, `${name}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Not in this directory, or not executable there: look on.
      }
    }
  }
  return false;
}

function run(command: string, args: readonly string[]): Promise<Executed> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(new Error(`Could not run ${command}`, { cause: error }));
        return;
      }
      resolve({
        exitCode: typeof error?.code === 'number' ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

/** Node leaves `isTTY` undefined, not false, on a stream that is no terminal. */
function isTerminal(stream: { readonly isTTY?: boolean }): boolean {
  return stream.isTTY ?? false;
}

export function processRuntime(): Runtime {
  return {
    env: process.env,
    environments: ENVIRONMENTS,
    cwd: process.cwd(),
    configDir: configDirOf(process.env),
    homeDir: homedir(),
    stdout: {
      write: (text) => process.stdout.write(text),
      isTTY: isTerminal(process.stdout),
    },
    stderr: {
      write: (text) => process.stderr.write(text),
      isTTY: isTerminal(process.stderr),
    },
    stdinIsTTY: isTerminal(process.stdin),
    fetch: globalThis.fetch,
    keychain: systemKeychain(),
    now: () => new Date(),
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    openBrowser: openInBrowser,
    hasCommand: onPath,
    exec: run,
  };
}
