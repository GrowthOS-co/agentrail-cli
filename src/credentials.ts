import { join } from 'node:path';

import type { Environment, EnvironmentName } from './environments.js';
import { CliError, EXIT } from './errors.js';
import { readJson, removeFile, writePrivateJson } from './files.js';
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

function asCredential(value: unknown, where: string): Credential {
  if (!isCredential(value)) {
    throw new CliError(
      EXIT.signIn,
      `The credential in ${where} is not one this CLI wrote. Run agentrail login again.`,
    );
  }
  return value;
}

export async function loadCredential(
  runtime: Runtime,
  environment: Environment,
): Promise<StoredCredential | undefined> {
  const file = await readJson(filePath(runtime, environment.name));
  if (file !== undefined) {
    return {
      credential: asCredential(file, 'the credentials file'),
      storage: 'file',
    };
  }
  if (!runtime.keychain) return undefined;
  let secret: string | null;
  try {
    secret = runtime.keychain.get(environment.name);
  } catch (error) {
    throw new CliError(
      EXIT.signIn,
      `Could not read the OS keychain (${(error as Error).message}). To keep credentials in a file instead, run ${commandFor(environment, 'login --insecure-storage')}.`,
      { cause: error },
    );
  }
  return secret === null
    ? undefined
    : {
        credential: asCredential(JSON.parse(secret), 'the OS keychain'),
        storage: 'keychain',
      };
}

export async function saveCredential(
  runtime: Runtime,
  credential: Credential,
  storage: Storage,
): Promise<void> {
  if (storage === 'file') {
    await writePrivateJson(
      filePath(runtime, credential.environment),
      credential,
    );
    return;
  }
  const environmentFlag =
    credential.environment === 'prod' ? '' : ` --env ${credential.environment}`;
  if (!runtime.keychain) {
    throw new CliError(
      EXIT.usage,
      `This system has no OS keychain. To keep credentials in a file instead, run agentrail login --insecure-storage${environmentFlag}.`,
    );
  }
  try {
    runtime.keychain.set(credential.environment, JSON.stringify(credential));
  } catch (error) {
    throw new CliError(
      EXIT.usage,
      `Could not write to the OS keychain (${(error as Error).message}). To keep credentials in a file instead, run agentrail login --insecure-storage${environmentFlag}.`,
      { cause: error },
    );
  }
}

/** Removes a sign-in from both places; true when there was one. */
export async function deleteCredential(
  runtime: Runtime,
  environment: Environment,
): Promise<boolean> {
  const stored = await loadCredential(runtime, environment);
  await removeFile(filePath(runtime, environment.name));
  if (stored?.storage === 'keychain') {
    runtime.keychain?.delete(environment.name);
  }
  return stored !== undefined;
}
