import { join } from 'node:path';

import {
  commandFor,
  saveCredential,
  type Credential,
  type Storage,
} from './credentials.js';
import { discoverSignIn } from './discovery.js';
import {
  clientIdOf,
  type Environment,
  type EnvironmentName,
} from './environments.js';
import { CliError, EXIT } from './errors.js';
import { readJson, removeFile, writePrivateJson } from './files.js';
import type { Runtime } from './runtime.js';
import { credentialFrom, postForm, requestTokens } from './tokens.js';

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// offline_access asks for a refresh token, so a sign-in outlives its
// short-lived access token.
const SCOPE = 'openid profile email offline_access';
/** RFC 8628 §3.2: the polling interval when the server names none. */
const DEFAULT_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: how much longer to wait after `slow_down`. */
const SLOW_DOWN_SECONDS = 5;

/**
 * A device sign-in started and not yet finished. Kept on disk so an agent
 * without a terminal can start it in one command and finish it in the next
 * (CLI-005). The device code is short-lived and the file private.
 */
export interface PendingLogin {
  readonly environment: EnvironmentName;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string | undefined;
  readonly intervalSeconds: number;
  readonly expiresAt: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly resource: string;
  readonly storage: Storage;
}

function pendingPath(runtime: Runtime, environment: EnvironmentName): string {
  return join(runtime.configDir, 'pending-login', `${environment}.json`);
}

/** Asks the environment's authorization server for a device code. */
export async function startDeviceLogin(
  runtime: Runtime,
  environment: Environment,
  storage: Storage,
): Promise<PendingLogin> {
  const clientId = clientIdOf(environment);
  const endpoints = await discoverSignIn(runtime, environment.mcpUrl);
  const { status, body } = await postForm(
    runtime,
    endpoints.deviceAuthorizationEndpoint,
    // The resource makes the token one the MCP server accepts (RFC 8707).
    { client_id: clientId, scope: SCOPE, resource: endpoints.resource },
  );
  if (
    status !== 200 ||
    typeof body.device_code !== 'string' ||
    typeof body.user_code !== 'string' ||
    typeof body.verification_uri !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    const reason = typeof body.error === 'string' ? `: ${body.error}` : '';
    throw new CliError(
      EXIT.unavailable,
      `Could not start signing in to ${environment.name}${reason}.`,
    );
  }
  const pending: PendingLogin = {
    environment: environment.name,
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete:
      typeof body.verification_uri_complete === 'string'
        ? body.verification_uri_complete
        : undefined,
    intervalSeconds:
      typeof body.interval === 'number'
        ? body.interval
        : DEFAULT_INTERVAL_SECONDS,
    expiresAt: new Date(
      runtime.now().getTime() + body.expires_in * 1_000,
    ).toISOString(),
    tokenEndpoint: endpoints.tokenEndpoint,
    clientId,
    resource: endpoints.resource,
    storage,
  };
  await writePrivateJson(pendingPath(runtime, environment.name), pending);
  return pending;
}

/** The sign-in an earlier command started, unless it has expired. */
export async function pendingLogin(
  runtime: Runtime,
  environment: Environment,
): Promise<PendingLogin | undefined> {
  const path = pendingPath(runtime, environment.name);
  const pending = (await readJson(path)) as PendingLogin | undefined;
  if (pending === undefined) return undefined;
  if (new Date(pending.expiresAt) <= runtime.now()) {
    await removeFile(path);
    return undefined;
  }
  return pending;
}

/**
 * Polls until the user approves or declines the code in their browser, or it
 * expires, then stores the credential and forgets the pending sign-in.
 */
export async function completeDeviceLogin(
  runtime: Runtime,
  environment: Environment,
  pending: PendingLogin,
): Promise<Credential> {
  const path = pendingPath(runtime, environment.name);
  const retry = commandFor(environment, 'login');
  let interval = pending.intervalSeconds;
  for (;;) {
    await runtime.sleep(interval * 1_000);
    if (new Date(pending.expiresAt) <= runtime.now()) {
      await removeFile(path);
      throw new CliError(
        EXIT.signIn,
        `The sign-in code expired. Run ${retry} again.`,
      );
    }
    const answer = await requestTokens(runtime, pending.tokenEndpoint, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: pending.deviceCode,
      client_id: pending.clientId,
    });
    if (answer.kind === 'tokens') {
      const credential = credentialFrom(runtime, answer, {
        environment: environment.name,
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId,
        resource: pending.resource,
      });
      await saveCredential(runtime, credential, pending.storage);
      await removeFile(path);
      return credential;
    }
    switch (answer.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval += SLOW_DOWN_SECONDS;
        break;
      case 'access_denied':
        await removeFile(path);
        throw new CliError(
          EXIT.signIn,
          `The sign-in was declined. Run ${retry} to try again.`,
        );
      case 'expired_token':
        await removeFile(path);
        throw new CliError(
          EXIT.signIn,
          `The sign-in code expired. Run ${retry} again.`,
        );
      default:
        throw new CliError(
          EXIT.unavailable,
          `Signing in failed: ${answer.error}.`,
        );
    }
  }
}
