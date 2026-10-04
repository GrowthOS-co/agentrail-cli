import { join } from 'node:path';

import type { Environment, EnvironmentName } from './environments.js';
import { causeOf, CliError, EXIT } from './errors.js';
import {
  isSystemError,
  readJson,
  removeFile,
  writePrivateJson,
} from './files.js';
import type { Runtime } from './runtime.js';

/** A sign-in to one environment: the tokens and where to refresh them. */
export interface Credential {
  readonly environment: EnvironmentName;
  readonly accessToken: string;
  /** Replaced after every refresh: WorkOS accepts each one once. */
  readonly refreshToken: string | undefined;
  readonly expiresAt: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly resource: string;
  readonly email: string | undefined;
}

/**
 * The OS keychain by default (CLI-007). A file only when the user asked for
 * one at sign-in with `--insecure-storage`, and only ever readable by them.
 */
export type Storage = 'keychain' | 'file';

export interface StoredCredential {
  readonly credential: Credential;
  readonly storage: Storage;
}

/** The command that runs `command` in an environment, for messages. */
export function commandFor(environment: Environment, command: string): string {
  return `agentrail ${command}${environment.name === 'prod' ? '' : ` --env ${environment.name}`}`;
}

function filePath(runtime: Runtime, environment: EnvironmentName): string {
  return join(runtime.configDir, 'credentials', `${environment}.json`);
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accessToken === 'string' &&
    typeof record.expiresAt === 'string' &&
    typeof record.tokenEndpoint === 'string' &&
    typeof record.clientId === 'string' &&
    typeof record.resource === 'string'
  );
}

function notOurs(environment: Environment, where: string): CliError {
  return new CliError(
    EXIT.signIn,
    `The sign-in in ${where} is not one this CLI wrote. Run ${commandFor(environment, 'login')} to replace it.`,
  );
}

/** The credentials file's sign-in; a file cut short or edited by hand is named. */
async function fromFile(
  runtime: Runtime,
  environment: Environment,
): Promise<Credential | undefined> {
  const path = filePath(runtime, environment.name);
  let value: unknown;
  try {
    value = await readJson(path);
  } catch (error) {
    if (error instanceof SyntaxError) throw notOurs(environment, path);
    throw error;
  }
  if (value === undefined) return undefined;
  if (!isCredential(value)) throw notOurs(environment, path);
  return value;
}

function keychainHint(environment: Environment): string {
  return `To keep credentials in a file instead, run ${commandFor(environment, 'login --insecure-storage')}.`;
}

function fromKeychain(
  runtime: Runtime,
  environment: Environment,
): Credential | undefined {
  let secret: string | null;
  try {
    secret = runtime.keychain.get(environment.name);
  } catch (error) {
    throw new CliError(
      EXIT.signIn,
      `Could not read the OS keychain (${causeOf(error)}). ${keychainHint(environment)}`,
      { cause: error },
    );
  }
  if (secret === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw notOurs(environment, 'the OS keychain');
    }
    throw error;
  }
  if (!isCredential(value)) throw notOurs(environment, 'the OS keychain');
  return value;
}

/** The stored sign-in: the credentials file's when there is one. */
export async function loadCredential(
  runtime: Runtime,
  environment: Environment,
): Promise<StoredCredential | undefined> {
  const file = await fromFile(runtime, environment);
  if (file !== undefined) return { credential: file, storage: 'file' };
  const kept = fromKeychain(runtime, environment);
  return kept === undefined
    ? undefined
    : { credential: kept, storage: 'keychain' };
}

export async function saveCredential(
  runtime: Runtime,
  environment: Environment,
  credential: Credential,
  storage: Storage,
): Promise<void> {
  const path = filePath(runtime, environment.name);
  if (storage === 'file') {
    await writePrivateJson(path, credential);
    return;
  }
  try {
    runtime.keychain.set(environment.name, JSON.stringify(credential));
  } catch (error) {
    throw new CliError(
      EXIT.usage,
      `Could not write to the OS keychain (${causeOf(error)}). ${keychainHint(environment)}`,
      { cause: error },
    );
  }
  // A file from an earlier --insecure-storage sign-in would be read first,
  // hiding the one just kept in the keychain.
  try {
    await removeFile(path);
  } catch (error) {
    if (!isSystemError(error)) throw error;
    throw new CliError(
      EXIT.usage,
      `The sign-in is kept in the OS keychain, but ${path} could not be removed (${error.code ?? ''}), and commands read it first. Remove it, then run your command again.`,
      { cause: error },
    );
  }
}

/** Where `logout` found a sign-in and removed it. */
export interface Removal {
  readonly file: boolean;
  readonly keychain: boolean;
  /** Why the keychain could not be asked, when it could not. */
  readonly keychainFailure: string | undefined;
}

/**
 * Removes the sign-in from both places, readable or not. A keychain that
 * cannot be asked (locked, or none on this system, as for those who sign in
 * with --insecure-storage) is reported, never counted as removed.
 */
export async function deleteCredential(
  runtime: Runtime,
  environment: Environment,
): Promise<Removal> {
  const file = await removeFile(filePath(runtime, environment.name));
  try {
    return {
      file,
      keychain: runtime.keychain.delete(environment.name),
      keychainFailure: undefined,
    };
  } catch (error) {
    // The keychain's own failures carry no type of their own: every one is
    // this call failing.
    return { file, keychain: false, keychainFailure: causeOf(error) };
  }
}
